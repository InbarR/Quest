const { Resvg } = require('@resvg/resvg-js');
const fs = require('fs');
const path = require('path');

// Read the SVG
const svgPath = path.join(__dirname, '..', 'resources', 'query-studio.svg');
let svg = fs.readFileSync(svgPath, 'utf8');

// Replace currentColor with a nice blue color for visibility
svg = svg.replace(/currentColor/g, '#0078D4');

// Also set a background and make it more visible
// Wrap in a new SVG with background
const wrappedSvg = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="128" height="128">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#1e1e2e;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#2d2d44;stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect width="24" height="24" rx="4" fill="url(#bg)"/>
  <g transform="translate(0, 1)">
    <!-- Database cylinder -->
    <ellipse cx="10" cy="6" rx="7" ry="2.5" fill="none" stroke="#569CD6" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M3 6v10c0 1.38 3.13 2.5 7 2.5s7-1.12 7-2.5V6" fill="none" stroke="#569CD6" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M3 11c0 1.38 3.13 2.5 7 2.5s7-1.12 7-2.5" fill="none" stroke="#569CD6" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>

    <!-- Sparkle/Star (4-point) - gold color -->
    <path d="M20 4 L20 8 M18 6 L22 6" fill="none" stroke="#FFD700" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>

    <!-- Small sparkle -->
    <path d="M18 12 L18 14 M17 13 L19 13" fill="none" stroke="#FFD700" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>

    <!-- Tiny sparkle -->
    <circle cx="21" cy="10" r="0.7" fill="#FFD700"/>
  </g>
</svg>
`;

// Convert to PNG
const resvg = new Resvg(wrappedSvg, {
    fitTo: {
        mode: 'width',
        value: 128
    }
});

const pngData = resvg.render();
const pngBuffer = pngData.asPng();

// Save the PNG
const outputPath = path.join(__dirname, '..', 'resources', 'icon.png');
fs.writeFileSync(outputPath, pngBuffer);

console.log(`Icon saved to: ${outputPath}`);
console.log(`Size: ${pngBuffer.length} bytes`);
