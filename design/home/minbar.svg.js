// The minbar, drawn in single gold lines: the gate with its crown, the side panel filled with the
// site's star lattice, the railing, the seat with its door, the columns and the pointed dome.
// A window lets light fall across it. Every stroke is a separate path so it can be drawn in.
const k = 0.8125; // the stair's slope
const hyp = x => 470 - k * (x - 150);
const rail = x => 400 - k * (x - 150);

const balusters = [];
for (let x = 166; x <= 456; x += 18) balusters.push(`<path class="ln b" d="M${x} ${hyp(x).toFixed(1)} V${rail(x).toFixed(1)}"/>`);

// Najdi-style crown: a row of small triangles (the shurfat on Riyadh's mud-brick walls)
const crown = (x0, x1, y) => {
  let d = `M${x0} ${y}`;
  for (let x = x0; x < x1; x += 10) d += ` L${x + 5} ${y - 9} L${x + 10} ${y}`;
  return `<path class="ln" d="${d}"/>`;
};

export const MINBAR = `<svg class="minbar" viewBox="0 0 640 560" role="img" aria-label="A minbar, the pulpit the khutbah is given from">
  <defs>
    <pattern id="lattice" width="40" height="40" patternUnits="userSpaceOnUse">
      <path d="M20 2.5 L37.5 20 L20 37.5 L2.5 20 Z M8.75 8.75 H31.25 V31.25 H8.75 Z" fill="none" stroke="currentColor" stroke-width="1"/>
    </pattern>
    <linearGradient id="beam" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="var(--light)" stop-opacity=".34"/>
      <stop offset=".55" stop-color="var(--light)" stop-opacity=".1"/>
      <stop offset="1" stop-color="var(--light)" stop-opacity="0"/>
    </linearGradient>
    <clipPath id="panel"><path d="M150 540 V470 L470 210 V540 Z"/></clipPath>
  </defs>

  <!-- the window and the light it lets in: the midday sun of Jumu'ah, the window's outline swept down to the floor -->
  <path class="beam" d="M34 210 V78 Q34 40 62 26 Q76 33 83 46 L416 540 H257 Z" fill="url(#beam)"/>
  <path class="ln win" d="M34 210 V78 Q34 40 62 26 Q90 40 90 78 V210 Z"/>
  <path class="ln win" d="M62 30 V210 M34 120 H90"/>

  <!-- the floor -->
  <path class="ln floor" d="M0 540 H640"/>

  <!-- the gate -->
  <path class="ln" d="M60 540 V252 H150 V540"/>
  ${crown(56, 154, 252)}
  <path class="ln" d="M80 540 V350 Q80 312 105 296 Q130 312 130 350 V540"/>
  <path class="ln thin" d="M68 262 H142 M68 270 H142"/>

  <!-- the side panel, filled with the star lattice -->
  <g clip-path="url(#panel)" class="lattice"><rect x="140" y="200" width="340" height="350" fill="url(#lattice)"/></g>
  <path class="ln" d="M150 470 L470 210"/>

  <!-- the railing -->
  <path class="ln" d="M150 400 L470 140"/>
  ${balusters.join('')}

  <!-- the seat, with the small door beneath it -->
  <path class="ln" d="M470 540 V140 H584 V540"/>
  <path class="ln" d="M502 540 V452 Q502 426 527 414 Q552 426 552 452 V540"/>
  <path class="ln thin" d="M470 214 H584"/>

  <!-- the columns, the canopy and the dome -->
  <path class="ln" d="M478 140 V96 M576 140 V96 M527 140 V96"/>
  <path class="ln" d="M470 96 H584"/>
  ${crown(470, 584, 96)}
  <path class="ln dome" d="M486 86 C486 58 518 50 527 18 C536 50 568 58 568 86"/>
  <path class="ln" d="M527 18 V4"/>
  <circle class="ln" cx="527" cy="4" r="2.6"/>
</svg>`;
