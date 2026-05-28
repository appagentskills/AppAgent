// Home View Management
function toggleHomeView() {
    if (currentView === 'home') return;
    openHomeView();
}

function openHomeView() {
    // Save pending state for current context before switching
    var prevContext = getCurrentPendingContext();
    savePendingImagesForContext(prevContext);
    savePendingTextForContext(prevContext);

    currentView = 'home';
    appStorage.setItem('currentView', 'home');
    hideAllPanels();
    hidePauseButton();
    var homePanel = document.getElementById('home-panel');
    if (homePanel) { homePanel.style.display = 'flex'; renderHome(); }
    // Browse button visibility is handled by setBrowserControlsVisibility in init
    updateAllButtonStates();
    renderChatList();

    // Restore pending state for home context
    restorePendingImagesForContext('home');

    // Restore pending text and focus home input after render
    setTimeout(function() {
        var input = document.getElementById('home-message-input');
        if (input) {
            input.value = chatPendingTexts['home'] || '';
            autoResizeTextarea(input);
            input.focus();
        }
    }, 100);
    // Push browser history state
    pushHistoryState('home', null);
}

function closeHomeView() {
    currentView = 'chat';
    appStorage.setItem('currentView', 'chat');
    stopHomeTrailAnimation();
    var homePanel = document.getElementById('home-panel');
    var mainArea = document.getElementById('main-area');
    if (homePanel) homePanel.style.display = 'none';
    showChatView();
    updateAllButtonStates();
}

// Home bike trail animation - simple bike game
var homeTrailAnimation = null;
var homeTrailCleanup = null;
function initHomeTrailAnimation() {
    var canvas = document.getElementById('home-trail-canvas');
    if (!canvas) return;
    
    var ctx = canvas.getContext('2d');
    var pathPoints = [];
    
    // Bike state
    var bikeX = 0;
    var bikeY = 0;
    var bikeVelX = 0.3; // Start very slow
    var bikeVelY = 0;
    var bikeAngle = 0;
    var isAirborne = false;
    var maxAccel = 0.055; // Max acceleration from mouse
    var friction = 0.988; // Speed decay (more friction)
    var boostActive = false;

    // Enhanced physics
    var wheelRotation = 0;
    var suspensionOffset = 0; // Suspension compression
    var targetSuspension = 0;
    var angularVelocity = 0; // For smooth rotation
    var airDrag = 0.998; // Air resistance
    var gravity = 0.42; // Gravity strength
    var landingImpact = 0; // Track hard landings
    
    // Mouse control
    var mouseX = 0;
    var mouseY = 0;
    var lastMouseX = 0;
    var lastMouseY = 0;
    
    // Game area (bottom 30% of page)
    var groundY = 0;
    
    // Generate random path with 90px bumps
    function generatePath() {
        pathPoints = [];
        var w = canvas.width;
        var h = canvas.height;
        
        // Ground level at bottom 30%
        groundY = h - 60;
        
        var padding = 30;
        var numPoints = 8 + Math.floor(Math.random() * 4); // 8-11 points (-30%)
        var points = [];
        
        // Start and end flat
        points.push({ x: -50, y: groundY });
        points.push({ x: padding, y: groundY });
        
        // Generate random hills and valleys
        for (var i = 0; i < numPoints; i++) {
            var xPos = padding + ((w - padding * 2) * (i + 1)) / (numPoints + 1);
            var yOffset = (Math.random() - 0.4) * 144; // -72 to +58 range (-20% height)
            // Ensure some variety - alternate between hills and valleys
            if (i > 0 && points[points.length - 1].y < groundY - 24) {
                yOffset = Math.random() * 48; // Go down after a hill
            } else if (i > 0 && points[points.length - 1].y > groundY + 16) {
                yOffset = -Math.random() * 72; // Go up after a valley
            }
            // Cap Y to stay within screen (leave 20px margin at bottom)
            var newY = Math.min(groundY + yOffset, h - 20);
            points.push({ x: xPos, y: newY });
        }
        
        // End flat
        points.push({ x: w - padding, y: groundY });
        points.push({ x: w + 50, y: groundY });
        
        // Generate smooth curve using Catmull-Rom spline
        for (var i = 0; i < points.length - 1; i++) {
            var p0 = points[Math.max(0, i - 1)];
            var p1 = points[i];
            var p2 = points[Math.min(points.length - 1, i + 1)];
            var p3 = points[Math.min(points.length - 1, i + 2)];
            
            for (var t = 0; t < 1; t += 0.02) {
                var t2 = t * t;
                var t3 = t2 * t;
                var x = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
                var y = 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
                pathPoints.push({ x: x, y: y });
            }
        }
    }
    
    // Get ground height and slope at x position
    function getGroundAt(x) {
        for (var i = 0; i < pathPoints.length - 1; i++) {
            if (pathPoints[i].x <= x && pathPoints[i + 1].x >= x) {
                var t = (x - pathPoints[i].x) / (pathPoints[i + 1].x - pathPoints[i].x);
                var y = pathPoints[i].y + (pathPoints[i + 1].y - pathPoints[i].y) * t;
                var angle = Math.atan2(pathPoints[i + 1].y - pathPoints[i].y, pathPoints[i + 1].x - pathPoints[i].x);
                return { y: y, angle: angle };
            }
        }
        return { y: groundY, angle: 0 };
    }
    
    function resize() {
        var panel = document.getElementById('home-panel');
        if (panel) {
            canvas.width = panel.offsetWidth;
            canvas.height = panel.offsetHeight;
            generatePath();
            // Reset bike on ground
            bikeX = 50;
            bikeY = getGroundAt(bikeX).y - 12;
            bikeVelX = 0;
            bikeVelY = 0;
        }
    }
    resize();
    window.addEventListener('resize', resize);
    
    // Mouse tracking
    var homePanel = document.getElementById('home-panel');
    function handleMouseMove(e) {
        var rect = canvas.getBoundingClientRect();
        lastMouseX = mouseX;
        lastMouseY = mouseY;
        mouseX = e.clientX - rect.left;
        mouseY = e.clientY - rect.top;
    }
    function handleMouseDown() {
        boostActive = true;
    }
    function handleMouseUp() {
        boostActive = false;
    }
    if (homePanel) {
        homePanel.addEventListener('mousemove', handleMouseMove);
        homePanel.addEventListener('mousedown', handleMouseDown);
        homePanel.addEventListener('mouseup', handleMouseUp);
    }
    homeTrailCleanup = function() {
        if (homePanel) {
            homePanel.removeEventListener('mousemove', handleMouseMove);
            homePanel.removeEventListener('mousedown', handleMouseDown);
            homePanel.removeEventListener('mouseup', handleMouseUp);
        }
        window.removeEventListener('resize', resize);
    };
    
    // Draw bike with suspension and wheel rotation
    function drawBike(x, y, angle, suspension) {
        ctx.save();
        ctx.translate(x, y + suspension);
        ctx.rotate(angle);

        // Speed-based color intensity
        var speed = Math.abs(bikeVelX);
        var intensity = Math.min(0.9 + speed * 0.02, 1);
        ctx.strokeStyle = 'rgba(99, 102, 241, ' + intensity + ')';
        ctx.fillStyle = 'rgba(99, 102, 241, 0.3)';
        ctx.lineWidth = 1.5;

        // Back wheel with rotation spokes
        ctx.beginPath();
        ctx.arc(-8, 6, 6, 0, Math.PI * 2);
        ctx.stroke();
        // Spoke lines for rotation effect
        for (var i = 0; i < 3; i++) {
            var spokeAngle = wheelRotation + (i * Math.PI * 2 / 3);
            ctx.beginPath();
            ctx.moveTo(-8 + Math.cos(spokeAngle) * 2, 6 + Math.sin(spokeAngle) * 2);
            ctx.lineTo(-8 + Math.cos(spokeAngle) * 5, 6 + Math.sin(spokeAngle) * 5);
            ctx.stroke();
        }

        // Front wheel with rotation spokes
        ctx.beginPath();
        ctx.arc(8, 6, 6, 0, Math.PI * 2);
        ctx.stroke();
        for (var i = 0; i < 3; i++) {
            var spokeAngle = wheelRotation + (i * Math.PI * 2 / 3);
            ctx.beginPath();
            ctx.moveTo(8 + Math.cos(spokeAngle) * 2, 6 + Math.sin(spokeAngle) * 2);
            ctx.lineTo(8 + Math.cos(spokeAngle) * 5, 6 + Math.sin(spokeAngle) * 5);
            ctx.stroke();
        }

        // Frame - diamond shape
        ctx.beginPath();
        ctx.moveTo(-8, 6);   // Back wheel
        ctx.lineTo(-2, -4);  // Seat post top
        ctx.lineTo(4, -2);   // Top tube
        ctx.lineTo(8, 6);    // Front wheel
        ctx.stroke();

        // Down tube
        ctx.beginPath();
        ctx.moveTo(-2, -4);
        ctx.lineTo(2, 6);
        ctx.lineTo(8, 6);
        ctx.stroke();

        // Seat
        ctx.beginPath();
        ctx.moveTo(-4, -6);
        ctx.lineTo(0, -6);
        ctx.stroke();

        // Handlebars
        ctx.beginPath();
        ctx.moveTo(4, -2);
        ctx.lineTo(6, -8);
        ctx.lineTo(9, -8);
        ctx.stroke();

        // Speed trail effect when going fast
        if (speed > 4) {
            ctx.globalAlpha = Math.min((speed - 4) * 0.1, 0.3);
            ctx.beginPath();
            ctx.moveTo(-14, 6);
            ctx.lineTo(-14 - speed * 2, 6);
            ctx.stroke();
            ctx.globalAlpha = 1;
        }

        ctx.restore();
    }
    
    // Draw dashed path
    function drawPath() {
        if (pathPoints.length < 2) return;
        
        ctx.beginPath();
        ctx.setLineDash([8, 12]);
        ctx.strokeStyle = 'rgba(99, 102, 241, 0.25)';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        
        ctx.moveTo(pathPoints[0].x, pathPoints[0].y);
        for (var i = 1; i < pathPoints.length; i++) {
            ctx.lineTo(pathPoints[i].x, pathPoints[i].y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
    }
    
    // Initialize bike on ground
    bikeX = 50;
    bikeY = groundY - 12;
    
    function animate() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        var ground = getGroundAt(bikeX);
        var bikeBottom = bikeY + 12; // Bottom of wheels

        // Hill Climb style: mouse right of center = gas, left = brake/reverse
        var canvasCenter = canvas.width / 2;
        var throttle = (mouseX - canvasCenter) / canvasCenter; // -1 to 1

        var boostMultiplier = boostActive ? 3.4 : 1.0;

        // Update wheel rotation based on velocity
        wheelRotation += bikeVelX * 0.15;

        // Smooth suspension
        suspensionOffset += (targetSuspension - suspensionOffset) * 0.3;
        targetSuspension *= 0.85; // Decay suspension

        // Check if airborne (with small threshold)
        var wasAirborne = isAirborne;
        isAirborne = bikeBottom < ground.y - 3;

        if (isAirborne) {
            // In air: gravity pulls down
            bikeVelY += gravity;

            // Air drag
            bikeVelX *= airDrag;
            bikeVelY *= airDrag;

            // Mouse controls rotation in air (angular momentum)
            angularVelocity += throttle * 0.008;
            angularVelocity *= 0.96; // Angular drag
            bikeAngle += angularVelocity;
            bikeAngle = Math.max(-1.4, Math.min(1.4, bikeAngle));

            // Air control for horizontal movement
            bikeVelX += throttle * 0.015;
        } else {
            // Landing detection
            if (wasAirborne) {
                // Calculate landing impact based on fall speed
                landingImpact = Math.abs(bikeVelY);
                if (landingImpact > 2) {
                    // Hard landing - trigger suspension compression
                    targetSuspension = Math.min(landingImpact * 1.5, 8);
                    // Speed penalty for bad landing angle
                    var angleDiff = Math.abs(bikeAngle - ground.angle);
                    if (angleDiff > 0.5) {
                        bikeVelX *= 0.7; // Lose speed on bad landing
                    }
                }
                angularVelocity = 0;
            }

            // On ground: follow terrain
            bikeY = ground.y - 12;

            // Smooth angle transition to match ground
            var targetAngle = ground.angle;
            bikeAngle += (targetAngle - bikeAngle) * 0.25;

            // Hill Climb physics
            var slopeAngle = ground.angle;

            // Gravity effect on slope
            var gravityOnSlope = Math.sin(slopeAngle) * 0.18;
            bikeVelX += gravityOnSlope;

            // Engine power with boost
            var enginePower = throttle * maxAccel * boostMultiplier;

            // Reduce power going uphill, increase downhill traction
            if (slopeAngle < 0 && throttle > 0) {
                // Going uphill with throttle
                enginePower *= (1 - Math.abs(slopeAngle) * 0.3);
            }

            bikeVelX += enginePower;

            // Rolling friction (more when braking)
            if (throttle < 0 && bikeVelX > 0) {
                bikeVelX *= 0.96; // Braking friction
            } else if (throttle > 0 && bikeVelX < 0) {
                bikeVelX *= 0.96; // Reversing friction
            } else {
                bikeVelX *= friction;
            }

            // Launch off ramp - improved detection
            var lookAhead = getGroundAt(bikeX + 10);
            var slopeChange = lookAhead.angle - slopeAngle;
            if (slopeAngle < -0.25 && bikeVelX > 1.2 && slopeChange > 0.1) {
                // Launch! Velocity based on speed and ramp angle
                var launchPower = Math.abs(bikeVelX) * 0.5 * (1 + Math.abs(slopeAngle));
                bikeVelY = -launchPower;
                angularVelocity = -slopeAngle * 0.1; // Spin based on ramp
                isAirborne = true;
            }
        }

        // Apply velocities
        bikeX += bikeVelX;
        bikeY += bikeVelY;

        // Ground collision
        if (bikeY + 12 > ground.y) {
            bikeY = ground.y - 12;
            bikeVelY = 0;
            isAirborne = false;
        }

        // Loop at edges with smooth transition
        if (bikeX > canvas.width + 30) {
            bikeX = -20;
            bikeY = getGroundAt(bikeX).y - 12;
            bikeVelY = 0;
            angularVelocity = 0;
        }
        if (bikeX < -30) {
            bikeX = canvas.width + 20;
            bikeY = getGroundAt(bikeX).y - 12;
            bikeVelY = 0;
            angularVelocity = 0;
        }

        // Draw path
        drawPath();

        // Draw bike with suspension offset
        drawBike(bikeX, bikeY, bikeAngle, suspensionOffset);

        homeTrailAnimation = requestAnimationFrame(animate);
    }
    
    animate();
}

function stopHomeTrailAnimation() {
    if (homeTrailAnimation) {
        cancelAnimationFrame(homeTrailAnimation);
        homeTrailAnimation = null;
    }
    if (homeTrailCleanup) {
        homeTrailCleanup();
        homeTrailCleanup = null;
    }
}

// Legacy: free-text example prompts. Shown as a fallback row when no
// `home`-placement actions are active. Skills with one-click actions render
// in the home actions row below; this list is just inspiration for new users.
var EXAMPLE_SUGGESTIONS = [
    // Auditing & Analysis
    { text: "Do a full audit on this instance", icon: "search" },
    { text: "Do a full audit of our incident management process", icon: "search" },
    { text: "Check the logs for issues or repetitive errors", icon: "file" },
    { text: "Review all P1 incidents and add context to them in work notes", icon: "edit" },
    { text: "What can be improved in this application?", icon: "info" },
    { text: "Are we using all the features of this app?", icon: "search" },

    // Testing & Validation
    { text: "Test this page and report any issues you find", icon: "browser" },
    { text: "Check the approval business flow end-to-end", icon: "tool" },
    { text: "Run a smoke test on the service catalog", icon: "play" },
    { text: "Once you finish testing, send me the report by email", icon: "send" },

    // Bug Fixing & Upgrades
    { text: "There's a bug in this form, can you fix it?", icon: "code" },
    { text: "Check the upgrade history and fix customization issues", icon: "tool" },
    { text: "Find and fix any broken scripts after the upgrade", icon: "code" },

    // Building & Development
    { text: "Build me a simple app to track team tasks", icon: "display" },
    { text: "Create a dashboard widget for my open tickets", icon: "stats" },
    { text: "Write a business rule to auto-assign incidents", icon: "code" },

    // Data & Import
    { text: "Import this Excel file into the user table", icon: "upload" },
    { text: "Export all incidents from last month to CSV", icon: "download" },
    { text: "Clean up duplicate records in the contacts table", icon: "database" },
    { text: "Add tags to this table for better organization", icon: "edit" },

    // Notifications & Automation
    { text: "Send me an email when the app install finishes", icon: "send" },
    { text: "Notify the team when a P1 incident is created", icon: "send" },
    { text: "Set up a daily report of unresolved tickets", icon: "timer" }
];

function renderHome() {
    var statsContainer = document.getElementById('home-stats');
    var cardsContainer = document.getElementById('home-cards');
    var contentEl = document.getElementById('home-content');
    if (!statsContainer || !cardsContainer || !contentEl) return;

    // Show home-content (hidden by default in HTML)
    contentEl.style.display = '';

    // Initialize trail animation
    stopHomeTrailAnimation();
    setTimeout(initHomeTrailAnimation, 100);

    // Get last 4 user prompts from all chats
    var recentPrompts = getRecentUserPrompts(4);

    // Free-text example chips — shown as a fallback row when no `home`-placement
    // actions are active. If any home actions exist, the actions row replaces
    // these chips entirely (one-click > free-text).
    var hasHomeActions = (typeof collectActionsForPlacement === 'function')
        && collectActionsForPlacement('home').length > 0;
    var shuffledExamples = hasHomeActions
        ? []
        : EXAMPLE_SUGGESTIONS.slice().sort(function() { return 0.5 - Math.random(); }).slice(0, 4);

    // Render home content with centered chat input (Google-style)
    contentEl.innerHTML =
        '<div class="home-search-section">' +
            '<div class="pending-images-container" id="home-pending-images-container" style="display:none;"></div>' +
            '<div class="home-search-container">' +
                '<textarea id="home-message-input" rows="1" placeholder="Send a message..." onkeydown="handleHomeKeyDown(event)" oninput="autoResizeTextarea(this)" aria-label="Message input"></textarea>' +
                '<button id="home-attach-btn" onclick="document.getElementById(\'home-image-file-input\').click()" title="Attach file (image, PDF, CSV, text)" aria-label="Attach file">' + UI_ICONS.attach + '</button>' +
                '<input type="file" id="home-image-file-input" accept="image/*,.pdf,application/pdf,.csv,.txt,.md,.json,.xml,.log,.yml,.yaml,text/*" multiple="multiple" style="display:none;" onchange="handleImageFileSelect(event)" />' +
                '<button id="home-send-btn" onclick="sendHomeMessage()" aria-label="Send message">' + UI_ICONS.send + '</button>' +
            '</div>' +
            (recentPrompts.length > 0 ? '<div class="home-recent-prompts" id="home-recent-prompts">' +
                '<span class="home-section-label">Recent</span>' +
                recentPrompts.map(function(p) {
                    return '<div class="home-prompt-chip" onclick="fillHomeInput(\'' + escapeHtml(p.text).replace(/'/g, "\\'").replace(/\n/g, ' ') + '\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \')fillHomeInput(\'' + escapeHtml(p.text).replace(/'/g, "\\'").replace(/\n/g, ' ') + '\')" title="' + escapeHtml(p.text) + '" role="button" tabindex="0">' + escapeHtml(truncateText(p.text, 35)) + '</div>';
                }).join('') +
            '</div>' : '') +
            // Free-text example chips fallback (only when no `home` actions exist).
            (shuffledExamples.length
                ? '<div class="home-example-chips">' +
                    shuffledExamples.map(function(ex) {
                        var iconHtml = UI_ICONS[ex.icon] ? '<span class="home-example-chip-icon">' + UI_ICONS[ex.icon] + '</span>' : '';
                        return '<div class="home-example-chip" onclick="fillHomeInput(\'' + escapeHtml(ex.text).replace(/'/g, "\\'") + '\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \')fillHomeInput(\'' + escapeHtml(ex.text).replace(/'/g, "\\'") + '\')" title="' + escapeHtml(ex.text) + '" role="button" tabindex="0">' + iconHtml + '<span>' + escapeHtml(ex.text) + '</span></div>';
                    }).join('') +
                  '</div>'
                : '') +
            (function() {
                var actionsHtml = renderActionsForPlacement('home', 'placement-home');
                return actionsHtml ? '<div class="home-actions-row" id="home-actions-row">' + actionsHtml + '</div>' : '';
            })() +
        '</div>' +
        '<div class="home-cards" id="home-cards"></div>' +
        '<div class="home-stats" id="home-stats"></div>';
    
    // Re-get containers after innerHTML update
    statsContainer = document.getElementById('home-stats');
    cardsContainer = document.getElementById('home-cards');

    // Live action pills row mirrors the chat-actions-row — populate it now
    // that the home DOM exists. Subsequent state changes refresh both rows
    // automatically via the onActionStateChange listener in 53e-actions.js.
    if (typeof renderLiveActionPills === 'function') renderLiveActionPills();

    // Calculate stats
    var chatCount = Object.keys(chats).length;
    var widgetCount = Object.keys(dashboardWidgets).length;
    var skillCount = Object.keys(skills).length;
    var toolCount = TOOLS.length;
    var cachedCredits = appStorage.getItem('cachedCredits') || '...';
    var systemPromptTokens = getSystemPromptTokenCount();
    var systemPromptTokensFormatted = systemPromptTokens >= 1000 ? (systemPromptTokens / 1000).toFixed(1) + 'k' : systemPromptTokens.toString();
    
    // Render stats (credits and storage will be updated async)
    statsContainer.innerHTML = 
        '<div class="home-stat-card"><div class="home-stat-value">' + chatCount + '</div><div class="home-stat-label">Chats</div></div>' +
        '<div class="home-stat-card"><div class="home-stat-value">' + widgetCount + '</div><div class="home-stat-label">Widgets</div></div>' +
        '<div class="home-stat-card"><div class="home-stat-value">' + skillCount + '</div><div class="home-stat-label">Skills</div></div>' +
        '<div class="home-stat-card"><div class="home-stat-value">' + toolCount + '</div><div class="home-stat-label">Tools</div></div>' +
        '<div class="home-stat-card"><div class="home-stat-value">' + systemPromptTokensFormatted + '</div><div class="home-stat-label">System Prompt</div></div>' +
        '<div class="home-stat-card"><div class="home-stat-value" id="home-credits-value">$' + cachedCredits + '</div><div class="home-stat-label">Credits</div></div>' +
        '<div class="home-stat-card"><div class="home-stat-value" id="home-storage-value">...</div><div class="home-stat-label">Storage</div></div>';
    
    // Fetch and update credits
    updateHomeCredits();
    // Fetch and update storage
    updateHomeStorage();
    
    // Render feature cards (compact)
    cardsContainer.innerHTML =
        '<div class="home-card" onclick="toggleSkillsView()" onkeydown="if(event.key===\'Enter\'||event.key===\' \')toggleSkillsView()" role="button" tabindex="0" aria-label="Open AI Skills">' +
            '<div class="home-card-icon" aria-hidden="true">' + UI_ICONS.skill + '</div>' +
            '<div class="home-card-title">AI Skills</div>' +
        '</div>' +
        '<div class="home-card" onclick="toggleDashboardView()" onkeydown="if(event.key===\'Enter\'||event.key===\' \')toggleDashboardView()" role="button" tabindex="0" aria-label="Open Smart Dashboard">' +
            '<div class="home-card-icon" aria-hidden="true">' + UI_ICONS.widget + '</div>' +
            '<div class="home-card-title">Smart Dashboard</div>' +
        '</div>' +
        '<div class="home-card" onclick="openBrowser()" onkeydown="if(event.key===\'Enter\'||event.key===\' \')openBrowser()" role="button" tabindex="0" aria-label="Open Browse with AI">' +
            '<div class="home-card-icon" aria-hidden="true">' + UI_ICONS.api + '</div>' +
            '<div class="home-card-title">Browse with AI</div>' +
        '</div>' +
        '<div class="home-card" onclick="toggleDocsView()" onkeydown="if(event.key===\'Enter\'||event.key===\' \')toggleDocsView()" role="button" tabindex="0" aria-label="Open Documentation">' +
            '<div class="home-card-icon" aria-hidden="true">' + UI_ICONS.book + '</div>' +
            '<div class="home-card-title">Documentation</div>' +
        '</div>' +
        '<div class="home-card" onclick="toggleSettingsView()" onkeydown="if(event.key===\'Enter\'||event.key===\' \')toggleSettingsView()" role="button" tabindex="0" aria-label="Open Settings">' +
            '<div class="home-card-icon" aria-hidden="true">' + UI_ICONS.settings + '</div>' +
            '<div class="home-card-title">Settings</div>' +
        '</div>';
}

// Update home credits display from cache (fetchCredits() handles the API call)
function updateHomeCredits() {
    var el = document.getElementById('home-credits-value');
    if (!el) return;
    var cachedCredits = appStorage.getItem('cachedCredits');
    if (cachedCredits) {
        el.textContent = '$' + cachedCredits;
    }
}

// Update home storage display
async function updateHomeStorage() {
    var el = document.getElementById('home-storage-value');
    if (!el) return;
    
    try {
        if (navigator.storage && navigator.storage.estimate) {
            var estimate = await navigator.storage.estimate();
            var usedMB = (estimate.usage || 0) / (1024 * 1024);
            if (usedMB < 1) {
                el.textContent = (usedMB * 1024).toFixed(0) + 'KB';
            } else {
                el.textContent = Math.round(usedMB) + 'MB';
            }
        } else {
            el.textContent = 'N/A';
        }
    } catch (e) {
        console.error('Failed to estimate storage:', e);
        el.textContent = 'N/A';
    }
}

// Get recent user prompts from all chats
function getRecentUserPrompts(count) {
    var prompts = [];
    var chatList = Object.values(chats).sort(function(a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });

    for (var i = 0; i < chatList.length && prompts.length < count; i++) {
        var chat = chatList[i];
        if (!chat.messages) continue;
        // Skip sub-agent / background chats — their "first user message" is the
        // synthetic spawn instruction (e.g. "You are a focused bug scout for the
        // AppAgent...") which the PM never typed. Leaking these into the Recent
        // prompts chip strip lets the PM click them as if they were their own past
        // prompts and resend a sub-agent system instruction to the foreground
        // model. `chat.isSubAgent` is stamped at sub-agent creation in
        // 097-sub-agent-registry.js; `isBackground` covers action chats too.
        if (chat.isSubAgent || chat.isBackground) continue;
        // Only get the first user message from each chat
        for (var j = 0; j < chat.messages.length; j++) {
            var msg = chat.messages[j];
            if (msg.role === 'user' && msg.content && msg.content.trim()) {
                var text = msg.content.trim();
                // Avoid duplicates
                if (!prompts.some(function(p) { return p.text === text; })) {
                    prompts.push({ text: text, chatId: chat.id });
                }
                break; // Only take the first user message per chat
            }
        }
    }
    return prompts;
}

// Truncate text with ellipsis
function truncateText(text, maxLen) {
    if (!text) return '';
    text = text.replace(/\n/g, ' ').trim();
    if (text.length <= maxLen) return text;
    return text.substring(0, maxLen) + '...';
}

// Fill home input with a prompt
function fillHomeInput(text) {
    var input = document.getElementById('home-message-input');
    if (input) {
        input.value = text;
        input.focus();
        autoResizeTextarea(input);
        // Persist for reload (programmatic .value doesn't fire input event)
        chatPendingTexts['home'] = text;
        persistPendingTextsToStorage();
    }
}

// Handle keydown in home input
function handleHomeKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendHomeMessage();
    }
}

// Send message from home input
function sendHomeMessage() {
    var input = document.getElementById('home-message-input');
    if (!input) return;
    var message = input.value.trim();
    if (!message && pendingImageAttachments.length === 0) return;

    // Clear home pending text since we're sending it
    delete chatPendingTexts['home'];
    persistPendingTextsToStorage();

    // Clear home input value so newChat()'s savePendingTextForContext doesn't re-save it
    input.value = '';

    // Preserve pending images before newChat() clears them
    var homePendingImages = pendingImageAttachments.slice();
    // Clear images from both memory and home context so newChat() doesn't re-save them
    pendingImageAttachments = [];
    delete chatPendingImages['home'];

    // Create new chat (this clears pending images)
    newChat();

    // Restore the home pending images into the new chat context
    pendingImageAttachments = homePendingImages;
    renderPendingImages();

    var mainInput = document.getElementById('message-input');
    if (mainInput) {
        mainInput.value = message;
        sendMessage();
    }
}
