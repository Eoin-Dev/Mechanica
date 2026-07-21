/** The formula guide's ready-made force-field recipes.
 *
 * Kept as a dependency-free data module so the test suite can compile
 * every recipe and round-trip the typeset ones without importing any UI.
 */
export interface Recipe {
  name: string;
  fx: string;
  fy: string;
  blurb: string;
}

export const RECIPES: Recipe[] = [
  { name: "Air drag", fx: "-0.5*vx", fy: "-0.5*vy",
    blurb: "Slows everything, always. Raise 0.5 for thicker air. " +
           "This is Stokes drag written by hand." },
  { name: "Spring to centre", fx: "-10*x", fy: "-10*y",
    blurb: "Everything oscillates or orbits about the origin. The " +
           "stiffness is the 10." },
  { name: "Gravity well", fx: "-8*x/(r^3+0.2)", fy: "-8*y/(r^3+0.2)",
    blurb: "Inverse-square attraction toward the origin (the x/r^3 form " +
           "includes the direction). The +0.2 softens the singularity." },
  { name: "Vortex", fx: "-4*y/(r+0.2)", fy: "4*x/(r+0.2)",
    blurb: "Pure swirl: the force is always perpendicular to the radius. " +
           "Swap the signs to reverse the spin." },
  { name: "Cyclone eye", fx: "6*x*exp(-(r/0.7)^4)", fy: "6*y*exp(-(r/0.7)^4)",
    blurb: "A smooth outward push that only exists inside r = 0.7 - a " +
           "switch with no if. The Cyclone preset uses exactly this trick." },
  { name: "Gusty wind", fx: "3*sin(2*t)+1", fy: "0",
    blurb: "A steady breeze plus a gust that reverses about every three " +
           "seconds. Time-varying fields animate the whole scene." },
  { name: "Anti-gravity", fx: "0", fy: "m*g",
    blurb: "Cancels standard gravity exactly for every mass - the m " +
           "makes it a force that produces equal acceleration." },
  { name: "Quadratic drag", fx: "-0.3*vx*abs(vx)", fy: "-0.3*vy*abs(vy)",
    blurb: "Aerodynamic drag: force grows with speed squared, so fast " +
           "bodies feel it much harder than slow ones." },
  { name: "Ceiling push", fx: "0", fy: "-0.4*m*(y > 2)",
    blurb: "Pushes down only above y = 2: the comparison is 1 inside the " +
           "zone and 0 outside. Text editing only." },
  { name: "Blinker", fx: "4 if floor(t) % 2 == 0 else -4", fy: "0",
    blurb: "Alternates a push left and right every second using if/else, " +
           "floor and %. Text editing only." },
];
