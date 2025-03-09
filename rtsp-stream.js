const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const rtspFFmpeg = require('rtsp-ffmpeg');
const bodyParser = require('body-parser');

// ===== CONFIGURABLE PARAMETERS =====
// Default configuration (can be overridden via API)
const defaultConfig = {
  // RTSP stream settings
  rtspUrl: 'rtsp://your-rtsp-url',
  transport: 'udp', // 'tcp' or 'udp'
  
  // Stream quality settings
  frameRate: 15,
  resolution: '640x360',
  quality: 3, // 1-31 (lower is better quality)
  
  // Server settings
  port: process.env.PORT || 3000,
  
  // Advanced FFmpeg options
  ffmpegOptions: [
    '-fflags', 'nobuffer',
    '-flags', 'low_delay'
  ]
};

// Current active configuration
let activeConfig = { ...defaultConfig };

// ===== APPLICATION SETUP =====
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  maxHttpBufferSize: 1e8, // 100MB max buffer size
  pingTimeout: 60000,     // Longer ping timeout for stability
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(express.static('public'));
app.use(bodyParser.json());

// ===== STREAM MANAGEMENT =====
// Stream state
let stream = null;
const activeClients = new Set();
let frameCount = 0;
let totalFrames = 0;
let lastFrameTime = 0;
let lastCounterReset = Date.now();

// Frame processing state
const frameQueues = new Map(); // Map of client ID to frame queue
const MAX_QUEUE_SIZE = 3;      // Maximum frames to buffer per client
const MAX_CLIENTS_PER_FRAME = 10; // Process clients in batches to avoid memory spikes

// Reset counters periodically for accurate stats
setInterval(() => {
  frameCount = 0;
  lastCounterReset = Date.now();
}, 10000);

// ===== STREAM FUNCTIONS =====
// Create a new stream with current configuration
function createStream(config = activeConfig) {
  if (stream) {
    try {
      stream.removeAllListeners();
      stream.stop();
    } catch (e) {
      console.error('Error cleaning up stream:', e);
    }
  }

  // Build FFmpeg arguments
  const ffmpegArgs = [
    '-rtsp_transport', config.transport,
    ...config.ffmpegOptions
  ];

  // Create new stream instance
  stream = new rtspFFmpeg.FFMpeg({
    input: config.rtspUrl,
    rate: config.frameRate,
    resolution: config.resolution,
    quality: config.quality,
    arguments: ffmpegArgs
  });

  // Set up frame handling
  stream.on('data', handleNewFrame);

  // Handle stream events
  stream.on('start', () => {
    console.log('Stream started');
    lastFrameTime = Date.now();
    io.emit('stream-status', { status: 'started' });
  });

  stream.on('stop', () => {
    console.log('Stream stopped');
    io.emit('stream-status', { status: 'stopped' });
  });

  // Enhanced error handling
  stream.on('error', (err) => {
    console.error('Stream error:', err);
    
    // Determine error type and send appropriate message
    let errorMessage = 'Stream error occurred';
    if (err.message.includes('Connection refused')) {
      errorMessage = 'Failed to connect to RTSP stream: Connection refused';
    } else if (err.message.includes('Invalid data')) {
      errorMessage = 'Invalid RTSP stream URL or stream not accessible';
    } else if (err.message.includes('timeout')) {
      errorMessage = 'Stream connection timed out';
    }
    
    // Notify clients about the error
    io.emit('stream-error', { 
      error: errorMessage,
      code: err.code || 'STREAM_ERROR'
    });
    
    // Try to restart on error after a short delay
    if (activeClients.size > 0) {
      setTimeout(() => {
        if (activeClients.size > 0) {
          try {
            startStreamIfNeeded();
          } catch (e) {
            console.error('Failed to restart stream:', e);
            io.emit('stream-error', { 
              error: 'Failed to restart stream',
              code: 'RESTART_FAILED'
            });
          }
        }
      }, 5000); // Increased delay to prevent rapid reconnection attempts
    }
  });

  return stream;
}

// Handle a new frame from the stream
function handleNewFrame(frameData) {
  totalFrames++;
  frameCount++;
  lastFrameTime = Date.now();
  
  // Group clients into batches to avoid memory spikes
  const clientBatches = [];
  const currentBatch = [];
  
  for (const clientId of activeClients) {
    currentBatch.push(clientId);
    if (currentBatch.length >= MAX_CLIENTS_PER_FRAME) {
      clientBatches.push([...currentBatch]);
      currentBatch.length = 0;
    }
  }
  
  // Add the last batch if it has any clients
  if (currentBatch.length > 0) {
    clientBatches.push(currentBatch);
  }
  
  // Process each batch with a small delay between them
  processClientBatch(0, clientBatches, frameData);
}

// Process a batch of clients for a frame
function processClientBatch(batchIndex, clientBatches, frameData) {
  if (batchIndex >= clientBatches.length) return;
  
  const batch = clientBatches[batchIndex];
  
  // Process each client in this batch
  for (const clientId of batch) {
    queueFrameForClient(clientId, frameData);
  }
  
  // Process next batch with a small delay to avoid memory spikes
  if (batchIndex + 1 < clientBatches.length) {
    setTimeout(() => {
      processClientBatch(batchIndex + 1, clientBatches, frameData);
    }, 5);
  }
}

// Queue a frame for a specific client
function queueFrameForClient(clientId, frameData) {
  const socket = io.sockets.sockets.get(clientId);
  if (!socket || !socket.connected) return;
  
  // Get or create queue for this client
  if (!frameQueues.has(clientId)) {
    frameQueues.set(clientId, []);
  }
  
  const queue = frameQueues.get(clientId);
  
  // Add to queue, maintaining maximum size
  queue.push(frameData);
  
  // If queue is too large, remove oldest frames
  if (queue.length > MAX_QUEUE_SIZE) {
    queue.splice(0, queue.length - MAX_QUEUE_SIZE);
  }
  
  // Send the frame to the client
  if (queue.length > 0 && socket.connected) {
    // Always send the newest frame for lowest latency
    const frameToSend = queue.pop();
    queue.length = 0; // Clear queue after sending
    
    // Send binary data directly
    socket.volatile.emit('stream', frameToSend, { binary: true });
  }
}

// Start the stream if clients are connected
function startStreamIfNeeded() {
  if (activeClients.size > 0) {
    if (!stream) {
      stream = createStream();
    }
    
    try {
      stream.start();
    } catch (e) {
      console.error('Error starting stream:', e);
    }
  }
}

// Stop the stream if no clients are connected
function stopStreamIfNoClients() {
  if (activeClients.size === 0 && stream) {
    try {
      stream.stop();
      console.log('Stream stopped (no clients)');
    } catch (e) {
      console.error('Error stopping stream:', e);
    }
  }
}

// Update stream with new configuration
function updateStreamConfig(newConfig) {
  // Merge new config with current config
  activeConfig = { ...activeConfig, ...newConfig };
  
  // Recreate stream with new config
  createStream(activeConfig);
  
  // Start stream if clients are connected
  startStreamIfNeeded();
  
  return activeConfig;
}

// Get current stream stats
function getStreamStats() {
  const now = Date.now();
  const secondsElapsed = (now - lastFrameTime) / 1000;
  const uptime = stream ? Math.round((now - lastCounterReset) / 1000) : 0;
  
  // Calculate current FPS
  let currentFps = 0;
  if (frameCount > 0 && secondsElapsed < 5) {
    const timeSinceReset = (now - lastCounterReset) / 1000;
    currentFps = Math.round(frameCount / Math.max(1, timeSinceReset));
    
    // Cap at reasonable values based on config
    const maxConfigFps = activeConfig.frameRate || 30;
    currentFps = Math.min(currentFps, maxConfigFps);
  }
  
  return {
    activeClients: activeClients.size,
    frameCount,
    totalFrames,
    currentFps,
    uptime,
    isActive: !!stream && activeClients.size > 0 && secondsElapsed < 5,
    config: activeConfig
  };
}

// ===== API ROUTES =====
// Get current configuration
app.get('/api/config', (req, res) => {
  res.json(activeConfig);
});

// Update configuration
app.post('/api/config', (req, res) => {
  try {
    const newConfig = req.body;
    const updatedConfig = updateStreamConfig(newConfig);
    res.json({ success: true, config: updatedConfig });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Reset to default configuration
app.post('/api/config/reset', (req, res) => {
  try {
    const updatedConfig = updateStreamConfig(defaultConfig);
    res.json({ success: true, config: updatedConfig });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

// Get stream stats
app.get('/api/stats', (req, res) => {
  res.json(getStreamStats());
});

// Serve the client-side RTSP player library
app.get('/rtsp-player.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.send(`
    // RTSP Stream Viewer Client Library
    class RTSPPlayer {
      constructor(options = {}) {
        // Add canvas initialization
        this.canvas = document.createElement('canvas');
        this.canvas.className = 'rtsp-player-canvas';
        this.ctx = this.canvas.getContext('2d', { alpha: false });
        
        // Create offscreen canvas for double buffering
        this.offscreenCanvas = document.createElement('canvas');
        this.offscreenCtx = this.offscreenCanvas.getContext('2d', { alpha: false });
        
        // Add status element
        this.statusEl = document.createElement('div');
        this.statusEl.className = 'rtsp-player-status';
        
        // Set initial canvas size
        this.canvasWidth = 640;
        this.canvasHeight = 480;
        this.canvas.width = this.canvasWidth;
        this.canvas.height = this.canvasHeight;
        this.offscreenCanvas.width = this.canvasWidth;
        this.offscreenCanvas.height = this.canvasHeight;
        
        // Default options
        this.options = {
          container: null,
          width: '100%',
          height: 'auto',
          autoConnect: true,
          ...options
        };
        
        // State
        this.frameCount = 0;
        this.currentConfig = {};
        this.connectionStatus = 'disconnected';
        this.lastValidFrame = null;
        this.processingFrame = false;
        this.frameTimeout = null;
        this.skippedFrames = 0;
        
        // Event callbacks
        this.onStatusChange = null;
        
        // Initialize the player
        this.init();
      }
      
      init() {
        // Validate container
        if (!this.options.container) {
          throw new Error('Container element is required');
        }
        
        const container = this.getContainer();
        if (!container) {
          throw new Error('Container element not found');
        }
        
        // Create player structure
        container.innerHTML = '';
        const wrapper = document.createElement('div');
        wrapper.className = 'rtsp-player-stream-wrapper';
        
        // Add elements to container
        wrapper.appendChild(this.canvas);
        wrapper.appendChild(this.statusEl);
        container.appendChild(wrapper);
        
        // Initialize socket connection
        if (this.options.autoConnect) {
          this.connect();
        }
      }
      
      getContainer() {
        if (typeof this.options.container === 'string') {
          return document.querySelector(this.options.container);
        }
        return this.options.container;
      }
      
      connect() {
        // Initialize Socket.io connection
        this.socket = io({
          reconnectionAttempts: Infinity,
          reconnectionDelay: 2000,
          reconnectionDelayMax: 10000,
          timeout: 10000,
          binaryType: 'arraybuffer'
        });
        
        // Show connecting status
        this.showStatus('Connecting to stream...');
        this.updateConnectionStatus('connecting', 'Connecting...');
        
        // Set up socket event handlers
        this.socket.on('connect', () => {
          this.showStatus('Establishing stream connection...');
        });
        
        // Add stream error handler
        this.socket.on('stream-error', (data) => {
          this.showStatus(data.error, true);
          
          // Start checking for stream recovery
          this.startStreamCheck();
        });
        
        // Add stream status handler
        this.socket.on('stream-status', (data) => {
          if (data.status === 'stopped') {
            this.showStatus('Stream stopped. Attempting to reconnect...', true);
            this.startStreamCheck();
          } else if (data.status === 'started') {
            // Wait for first frame before hiding status
            this.showStatus('Stream connected, waiting for video...');
          }
        });

        // Add stream check method
        this.startStreamCheck = () => {
          if (this.streamCheckInterval) {
            clearInterval(this.streamCheckInterval);
          }
          
          this.streamCheckInterval = setInterval(() => {
            if (this.frameCount === 0 || Date.now() - this.lastFrameTime > 5000) {
              this.showStatus('Stream not responding. Attempting to reconnect...', true);
              
              // Emit reconnect request
              this.socket.emit('stream-reconnect');
            }
          }, 5000);
        };

        // Track last frame time
        this.lastFrameTime = Date.now();
        
        // Handle stream data with timeout detection and frame validation
        this.socket.on('stream', async (data) => {
          // Skip if we're still processing a frame to prevent backlog
          if (this.processingFrame) {
            this.skippedFrames++;
            return;
          }
          
          // Set a flag to indicate we're processing a frame
          this.processingFrame = true;
          
          // Set a timeout to prevent hanging on a single frame
          this.frameTimeout = setTimeout(() => {
            this.processingFrame = false;
            console.debug('Frame processing timed out');
          }, 500); // 500ms timeout
          
          try {
            const blob = new Blob([data], {type: 'image/jpeg'});
            
            // Validate frame data before processing
            if (blob.size < 100) { // Minimum size for a valid JPEG
              throw new Error('Invalid frame data: too small');
            }
            
            const imageBitmap = await createImageBitmap(blob).catch(e => {
              throw new Error('Failed to decode image: ' + e.message);
            });
            
            // Draw to offscreen canvas first
            this.offscreenCtx.drawImage(imageBitmap, 0, 0, this.canvasWidth, this.canvasHeight);
            
            // Only after successful drawing to offscreen, copy to visible canvas
            this.ctx.drawImage(this.offscreenCanvas, 0, 0);
            
            // Store this as the last valid frame
            this.lastValidFrame = imageBitmap;
            
            imageBitmap.close();
            
            this.frameCount++;
            this.lastFrameTime = Date.now();
            
            // Clear stream check on successful frame
            if (this.streamCheckInterval && this.frameCount > 1) {
              clearInterval(this.streamCheckInterval);
              this.streamCheckInterval = null;
            }
            
            this.hideStatus();
            this.handleSuccessfulConnection();
          } catch (error) {
            // Log the error but don't show to user
            console.debug('Frame processing error:', error.message);
            
            // If we have a last valid frame, use it instead
            if (this.lastValidFrame && !this.lastValidFrame.closed) {
              try {
                // Redraw the last valid frame to maintain a stable image
                this.ctx.drawImage(this.lastValidFrame, 0, 0, this.canvasWidth, this.canvasHeight);
              } catch (e) {
                // If even this fails, the lastValidFrame might be invalid
                this.lastValidFrame = null;
              }
            }
          } finally {
            // Clear the timeout and reset processing flag
            if (this.frameTimeout) {
              clearTimeout(this.frameTimeout);
              this.frameTimeout = null;
            }
            this.processingFrame = false;
          }
        });
        
        // Handle configuration
        this.socket.on('config', (config) => {
          this.currentConfig = config;
          this.updateConfigForm(config);
        });
      }
      
      disconnect() {
        if (this.streamCheckInterval) {
          clearInterval(this.streamCheckInterval);
          this.streamCheckInterval = null;
        }
        if (this.socket) {
          this.socket.disconnect();
          this.socket = null;
        }
      }
      
      showStatus(message, isError = false) {
        if (!this.statusEl) return;
        
        // Create status content with appropriate styling
        const statusContent = isError 
          ? \`<div class="rtsp-player-status-content error">
               <span class="rtsp-player-status-icon">⚠️</span>
               <span class="rtsp-player-status-message">\${message}</span>
             </div>\`
          : \`<div class="rtsp-player-status-content">
               <span class="rtsp-player-spinner"></span>
               <span class="rtsp-player-status-message">\${message}</span>
             </div>\`;
        
        this.statusEl.innerHTML = statusContent;
        this.statusEl.classList.add('visible');
        
        // Add error class for styling
        if (isError) {
          this.statusEl.classList.add('error');
        } else {
          this.statusEl.classList.remove('error');
        }
      }
      
      hideStatus() {
        if (!this.statusEl) return;
        if (this.statusEl.classList.contains('visible')) {
          this.statusEl.classList.remove('visible');
        }
      }
      
      updateConnectionStatus(status, message) {
        this.connectionStatus = status;
        
        // Emit status change event
        if (this.onStatusChange) {
          this.onStatusChange(status, message);
        }
      }
      
      toggleConfigPanel(show) {
        const panel = document.getElementById('config-panel');
        if (show === undefined) {
          panel.classList.toggle('visible');
        } else {
          panel.classList[show ? 'add' : 'remove']('visible');
        }
      }
      
      updateConfigForm(config) {
        // Get elements from DOM instead of class properties
        const rtspUrlInput = document.getElementById('rtsp-url');
        const transportSelect = document.getElementById('transport');
        const frameRateInput = document.getElementById('framerate');
        const resolutionSelect = document.getElementById('resolution');
        const qualityInput = document.getElementById('quality');

        if (rtspUrlInput) rtspUrlInput.value = config.rtspUrl || '';
        if (transportSelect) transportSelect.value = config.transport || 'tcp';
        if (frameRateInput) frameRateInput.value = config.frameRate || '';
        if (resolutionSelect) resolutionSelect.value = config.resolution || '640x480';
        if (qualityInput) qualityInput.value = config.quality || '';

        // Parse resolution for canvas sizing
        if (config.resolution) {
          const [width, height] = config.resolution.split('x').map(Number);
          if (width && height) {
            this.updateCanvasSize(width, height);
          }
        }
      }
      
      applyConfig() {
        this.showStatus('Applying configuration changes...');
        
        // Get elements from DOM
        const rtspUrlInput = document.getElementById('rtsp-url');
        const transportSelect = document.getElementById('transport');
        const frameRateInput = document.getElementById('framerate');
        const resolutionSelect = document.getElementById('resolution');
        const qualityInput = document.getElementById('quality');

        const newConfig = {};
        
        if (rtspUrlInput?.value) newConfig.rtspUrl = rtspUrlInput.value;
        if (transportSelect?.value) newConfig.transport = transportSelect.value;
        if (frameRateInput?.value) newConfig.frameRate = parseInt(frameRateInput.value);
        if (resolutionSelect?.value) newConfig.resolution = resolutionSelect.value;
        if (qualityInput?.value) newConfig.quality = parseInt(qualityInput.value);

        // Send config to server
        this.socket.emit('update-config', newConfig);

        // Set a timeout to handle no response
        setTimeout(() => {
          this.showStatus('Configuration timed out. Try again.', true);
        }, 10000);
      }
      
      resetConfig() {
        this.showStatus('Resetting to default configuration...');
        
        fetch('/api/config/reset', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          }
        })
        .then(response => response.json())
        .catch(() => {
          this.showStatus('Failed to reset configuration', true);
        })
        .finally(() => {
          setTimeout(() => {
            this.showStatus('Reset to default configuration');
          }, 1000);
        });
      }
      
      async getStats() {
        try {
          const response = await fetch('/api/stats');
          if (!response.ok) {
            throw new Error('Failed to fetch stats');
          }
          const stats = await response.json();
          
          // Add client-side frame count to the stats
          stats.clientFrameCount = this.frameCount;
          stats.skippedFrames = this.skippedFrames || 0;
          
          return stats;
        } catch (error) {
          console.error('Error fetching stats:', error);
          return { error: error.message };
        }
      }
      
      setStatusChangeCallback(callback) {
        this.onStatusChange = callback;
      }

      // Add this new method to handle successful connections
      handleSuccessfulConnection() {
        this.hideStatus();
        this.updateConnectionStatus('connected', 'Connected');
      }

      // Update canvas size when resolution changes
      updateCanvasSize(width, height) {
        if (!width || !height) return;
        
        this.canvasWidth = width;
        this.canvasHeight = height;
        
        // Update both main and offscreen canvas
        this.canvas.width = width;
        this.canvas.height = height;
        this.offscreenCanvas.width = width;
        this.offscreenCanvas.height = height;
        
        // Clear both canvases to prevent artifacts
        this.ctx.fillStyle = '#000';
        this.ctx.fillRect(0, 0, width, height);
        this.offscreenCtx.fillStyle = '#000';
        this.offscreenCtx.fillRect(0, 0, width, height);
        
        // Reset last valid frame as it may no longer be the right size
        if (this.lastValidFrame && !this.lastValidFrame.closed) {
          this.lastValidFrame.close();
          this.lastValidFrame = null;
        }
      }
    }
    
    // Export to global scope
    window.RTSPPlayer = RTSPPlayer;
  `);
});

// Add CSS styles for enhanced visual feedback
app.get('/rtsp-player.css', (req, res) => {
  res.setHeader('Content-Type', 'text/css');
  res.send(`
    .rtsp-player-status {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: rgba(0, 0, 0, 0.8);
      color: white;
      padding: 15px 25px;
      border-radius: 8px;
      z-index: 1000;
      opacity: 0;
      visibility: hidden;
      transition: opacity 0.3s ease, visibility 0.3s ease;
      text-align: center;
      min-width: 200px;
    }

    .rtsp-player-status.visible {
      opacity: 1;
      visibility: visible;
    }

    .rtsp-player-status.error {
      background: rgba(255, 59, 48, 0.9);
    }

    .rtsp-player-status-content {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
    }

    .rtsp-player-status-icon {
      font-size: 18px;
    }

    .rtsp-player-status-message {
      font-size: 14px;
      font-weight: 500;
    }

    .rtsp-player-spinner {
      width: 20px;
      height: 20px;
      border: 2px solid rgba(255, 255, 255, 0.3);
      border-radius: 50%;
      border-top-color: #fff;
      animation: spin 1s ease-in-out infinite;
    }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  `);
});

// Serve the index.html file
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// ===== SOCKET HANDLING =====
io.on('connection', socket => {
  console.log('Client connected:', socket.id);
  activeClients.add(socket.id);
  
  // Send current configuration to client
  socket.emit('config', activeConfig);
  
  // Create stream if this is the first client
  if (activeClients.size === 1) {
    startStreamIfNeeded();
  }

  // Handle configuration updates from client
  socket.on('update-config', (newConfig) => {
    try {
      // Update stream configuration
      const updatedConfig = updateStreamConfig(newConfig);
      
      // Notify all clients about the configuration change
      io.emit('config', updatedConfig);
      
      // Notify clients that stream is restarting
      io.emit('stream-status', { status: 'restarting' });
      
      // After a short delay, notify that stream is ready
      setTimeout(() => {
        io.emit('stream-status', { status: 'ready' });
      }, 1000);
      
    } catch (error) {
      console.error('Error updating configuration:', error);
      socket.emit('error', { message: 'Failed to update stream configuration' });
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    activeClients.delete(socket.id);
    
    // Clean up frame queue for this client
    if (frameQueues.has(socket.id)) {
      frameQueues.delete(socket.id);
    }
    
    stopStreamIfNoClients();
  });
});

// ===== SERVER STARTUP =====
// Initialize stream with default config
stream = createStream();

// Start the server
server.listen(activeConfig.port, () => {
  console.log(`RTSP Stream Viewer running on http://localhost:${activeConfig.port}`);
}); 