// NATIVE SCREENSHOT CAPTURE - getDisplayMedia (no external libraries)
// =============================================

async function captureElementToCanvas(element) {
    // Get the element's bounding rect (position relative to viewport)
    var rect = element.getBoundingClientRect();

    // For iframe content, we need the iframe's position, not its body
    var targetElement = element;
    if (element.tagName === 'BODY' || element.tagName === 'HTML') {
        // Find the iframe that contains this element
        var win = element.ownerDocument.defaultView;
        if (win && win.frameElement) {
            targetElement = win.frameElement;
            rect = targetElement.getBoundingClientRect();
        }
    }

    // Request screen capture with preference for current tab
    var stream;
    try {
        stream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                displaySurface: 'browser'
            },
            preferCurrentTab: true
        });
    } catch (e) {
        throw new Error('Screen capture cancelled or denied: ' + e.message);
    }

    try {
        // Create video element to capture a frame
        var video = document.createElement('video');
        video.srcObject = stream;
        video.muted = true;

        // Wait for metadata
        await new Promise(function(resolve, reject) {
            video.onloadedmetadata = resolve;
            video.onerror = reject;
            setTimeout(function() { reject(new Error('Video load timeout')); }, 5000);
        });

        await video.play();

        // Wait for frame to render
        await new Promise(function(resolve) {
            requestAnimationFrame(function() {
                requestAnimationFrame(resolve);
            });
        });

        // Video dimensions (full captured area)
        var videoWidth = video.videoWidth;
        var videoHeight = video.videoHeight;

        // Device pixel ratio for HiDPI displays
        var dpr = window.devicePixelRatio || 1;

        // Calculate crop coordinates
        var cropX = Math.round(rect.left * dpr);
        var cropY = Math.round(rect.top * dpr);
        var cropWidth = Math.round(rect.width * dpr);
        var cropHeight = Math.round(rect.height * dpr);

        // Clamp to video bounds
        cropX = Math.max(0, Math.min(cropX, videoWidth - 1));
        cropY = Math.max(0, Math.min(cropY, videoHeight - 1));
        cropWidth = Math.min(cropWidth, videoWidth - cropX);
        cropHeight = Math.min(cropHeight, videoHeight - cropY);

        // Ensure valid dimensions
        if (cropWidth <= 0 || cropHeight <= 0) {
            throw new Error('Invalid crop dimensions');
        }

        // Create canvas and draw cropped region
        var canvas = document.createElement('canvas');
        canvas.width = cropWidth;
        canvas.height = cropHeight;
        var ctx = canvas.getContext('2d');

        ctx.drawImage(video,
            cropX, cropY, cropWidth, cropHeight,
            0, 0, cropWidth, cropHeight
        );

        return canvas;

    } finally {
        // Always stop the stream
        stream.getTracks().forEach(function(track) { track.stop(); });
    }
}

// =============================================