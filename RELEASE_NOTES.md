# Release Notes - v0.2

## Dark Mode
- Light, dark, and system (follows OS) theme options in Settings > Display
- Flash-free theme loading on page start

## Design Tokens
- Replaced hardcoded CSS values with a full token system: spacing, typography, radii, shadows, transitions, and colors
- Enables consistent theming and easier future customization

## Diff Viewer
- Focus mode: collapses unchanged lines, showing only changes with surrounding context
- Faster diff for large files (prefix/suffix trimming, LCS cell cap with fallback)
- Proper XML pretty-printing preserving CDATA sections
- Auto-scroll to first change on load

## Navigation
- `wait` parameter on navigate action: waits for full page load before returning
- Loading bar indicator on iframe header during navigation

## iOS / Mobile
- Pinch-to-zoom prevention on Safari iOS
- Apple Web App meta tags for home screen PWA support
