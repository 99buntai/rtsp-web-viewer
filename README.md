# RTSP Stream Viewer

A Node.js library for converting RTSP streams to MJPEG for web browser viewing with minimal latency. 

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node Version](https://img.shields.io/badge/node-%3E%3D14.0.0-brightgreen.svg)

## Features

- **Low-Latency Streaming**: Optimized for minimal delay using WebSocket transport
- **Robust Error Handling**: Automatic reconnection and comprehensive error reporting
- **Responsive UI**: Modern interface with loading states and error feedback
- **Multiple Resolution Support**: 320x240 to 1920x1080 (configurable)
- **Transport Protocol Options**: TCP or UDP
- **Quality Control**: Adjustable compression quality (1-31, lower is better)
- **Frame Rate Control**: Configurable target FPS
- **Performance Monitoring**: Real-time statistics and health checks
- **Multiple Client Support**: Efficient handling of multiple viewers
- **TypeScript Support**: Full type definitions included

## Prerequisites

- Node.js (v14.0.0 or higher)
- FFmpeg must be installed and available in your PATH

### FFmpeg Installation

#### macOS
```bash
brew install ffmpeg
```

#### Ubuntu/Debian
```bash
sudo apt-get update
sudo apt-get install ffmpeg
```

#### Windows
1. Download from [ffmpeg.org](https://ffmpeg.org/download.html)
2. Extract the files
3. Add the bin folder to your system PATH

## Installation

```bash
npm install rtsp-stream-viewer
```

## Quick Start

### Basic Server Setup
```javascript
const RTSPStreamServer = require('rtsp-stream-viewer');

const server = new RTSPStreamServer({
  rtspUrl: 'rtsp://your-camera-url:554/stream',
  port: 3000
});

server.start()
  .then(() => console.log('Server running on http://localhost:3000'))
  .catch(console.error);
```

### Basic Client Implementation
```html
<!DOCTYPE html>
<html>
<head>
    <title>RTSP Stream Viewer</title>
    <link rel="stylesheet" href="/rtsp-player.css">
</head>
<body>
    <div id="player-container"></div>

    <script src="/socket.io/socket.io.js"></script>
    <script src="/rtsp-player.js"></script>
    <script>
        const player = new RTSPPlayer({
            container: '#player-container',
            autoConnect: true
        });
    </script>
</body>
</html>
```

## Configuration

### Default Configuration
```javascript
const defaultConfig = {
  rtspUrl: 'rtsp://your-camera-url:554/stream',
  transport: 'udp',         // 'tcp' or 'udp'
  frameRate: 15,           // Default frame rate
  resolution: '640x360',   // Default resolution
  quality: 3,             // JPEG quality (1-31, lower is better)
  port: 3000,            // Server port
  ffmpegOptions: [      // Advanced FFmpeg options
    '-fflags', 'nobuffer',
    '-flags', 'low_delay'
  ]
};
```

### Stream Performance Settings
```javascript
const streamSettings = {
  maxQueueSize: 3,            // Maximum frames to buffer per client
  maxClientsPerFrame: 10,     // Process clients in batches
  statsResetInterval: 10000   // Reset frame counters every 10 seconds
};
```

## API Reference

### Server-Side (RTSPStreamServer)

#### Configuration Options
```typescript
interface RTSPConfig {
    rtspUrl: string;          // RTSP stream URL
    transport: 'tcp' | 'udp'; // Transport protocol
    frameRate: number;        // Target frame rate (1-60)
    resolution: string;       // Video resolution (e.g., '640x360')
    quality: number;         // JPEG quality (1-31, lower is better)
    port: number;           // Server port
    ffmpegOptions: string[]; // Additional FFmpeg options
}
```

#### Stream Statistics
```typescript
interface StreamStats {
    activeClients: number;     // Number of connected clients
    frameCount: number;        // Frames processed since last reset
    totalFrames: number;       // Total frames processed
    currentFps: number;        // Current frames per second
    uptime: number;           // Stream uptime in seconds
    isActive: boolean;        // Stream active status
    config: RTSPConfig;       // Current configuration
    skippedFrames: number;    // Frames skipped due to processing backlog
}
```

#### REST API Endpoints
- \`GET /api/config\` - Get current configuration
- \`POST /api/config\` - Update configuration
- \`POST /api/config/reset\` - Reset to default configuration
- \`GET /api/stats\` - Get stream statistics
- \`GET /health\` - Server health check

### Client-Side (RTSPPlayer)

#### Visual Feedback States
- Status messages with error states
- Connection status indicator
- Stream statistics display

#### CSS Customization
The player provides customizable CSS classes:
```css
.rtsp-player-stream-wrapper    // Stream container
.rtsp-player-canvas           // Video canvas
.rtsp-player-status          // Status message overlay
.rtsp-player-spinner        // Loading spinner
.rtsp-player-status-content // Status message content
.rtsp-player-status.error   // Error state styling
```

#### Socket Events
\`\`\`javascript
// Emitted Events
socket.emit('update-config', newConfig);    // Update stream configuration
socket.emit('stream-reconnect');           // Request stream reconnection

// Received Events
socket.on('stream', (data) => {});        // Receive frame data
socket.on('stream-error', (data) => {});  // Stream error occurred
socket.on('stream-status', (data) => {}); // Stream status update
socket.on('config', (config) => {});      // Configuration updated
\`\`\`

## Advanced Features

### Frame Processing
- Batch processing for multiple clients
- Frame queue management per client
- Frame skipping for processing backlog prevention
- Double buffering for tear-free rendering

### Error Recovery
- Automatic stream reconnection
- Graduated reconnection delays (2-10 seconds)
- Error-specific status messages
- Stream health monitoring
- Last valid frame caching for stable display

### Performance Monitoring
```javascript
// Stream Statistics
const stats = await player.getStats();
{
    activeClients,     // Current connected clients
    frameCount,        // Frames since last reset
    totalFrames,       // Total processed frames
    currentFps,        // Current FPS
    uptime,           // Stream uptime
    isActive,         // Stream active status
    config,           // Current configuration
    skippedFrames     // Frames skipped due to processing backlog
}
```

### Memory Management
- Frame queue size limits
- Batch processing to prevent memory spikes
- Automatic cleanup of disconnected clients
- Frame processing lock to prevent backlog

### UI Improvements
- Streamlined configuration panel with auto-close on apply
- Simplified controls for better user experience
- Responsive design for various screen sizes
- Real-time status indicators

## Error Handling

### Server-Side Errors
```javascript
// Stream Errors
'Failed to connect to RTSP stream: Connection refused'
'Invalid RTSP stream URL or stream not accessible'
'Stream connection timed out'
'Failed to restart stream'
'Stream error occurred'

// Configuration Errors
'Failed to update stream configuration'
'Failed to reset configuration'
```

### Client-Side Errors
```javascript
// Connection States
'connecting'    // Initial connection attempt
'connected'     // Successfully connected
'disconnected'  // Connection lost
'error'         // Error state

// Error Messages
'Stream not responding. Attempting to reconnect...'
'Connection timeout. Retrying...'
'Connection refused. Retrying...'
'Failed to connect to stream. Retrying...'
'Stream stopped. Attempting to reconnect...'
```

## Best Practices

### Resource Management
1. **Memory Usage**
   - Monitor frame queue sizes
   - Use batch processing for multiple clients
   - Implement automatic cleanup

2. **Network Optimization**
   - Use appropriate transport protocol
   - Adjust frame rate based on network
   - Monitor skipped frames
   - Implement reconnection strategy
   - Frame validation to prevent rendering corrupted data

3. **Client Management**
   - Limit maximum concurrent clients
   - Process clients in batches
   - Clean up disconnected clients
   - Monitor client performance

## Troubleshooting

### Common Issues

1. **Black Screen**
   - Check RTSP URL accessibility
   - Verify FFmpeg installation
   - Check network connectivity
   - Try switching transport protocol (TCP/UDP)

2. **High Latency**
   - Reduce resolution
   - Lower frame rate
   - Adjust quality setting
   - Check network conditions

3. **Connection Issues**
   - Verify RTSP server is running
   - Check firewall settings
   - Ensure correct port configuration
   - Verify network permissions

4. **Performance Issues**
   - Reduce number of concurrent clients
   - Lower resolution or frame rate
   - Adjust buffer settings
   - Monitor server resources

## Security Considerations

1. **RTSP Authentication**
   - Use authenticated RTSP URLs
   - Implement token-based authentication
   - Secure credentials storage

2. **Network Security**
   - Use HTTPS for web interface
   - Implement WebSocket security
   - Configure CORS appropriately
   - Rate limit connections

## Contributing

1. Fork the repository
2. Create your feature branch (\`git checkout -b feature/AmazingFeature\`)
3. Commit your changes (\`git commit -m 'Add some AmazingFeature'\`)
4. Push to the branch (\`git push origin feature/AmazingFeature\`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Acknowledgments

- FFmpeg for video processing
- Socket.IO for WebSocket implementation
- Express.js for HTTP server
- Node.js community for support and packages