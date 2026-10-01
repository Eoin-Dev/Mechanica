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
  captureGravity?: boolean;
}

/** Resolve context-sensitive examples to ordinary, portable formula sources. */
export function recipeSources(recipe: Recipe, worldGravity: number): { fx: string; fy: string } {
  if (recipe.captureGravity && !Number.isFinite(worldGravity)) {
    throw new RangeError("Recipe gravity must be finite");
  }
  return { fx: recipe.fx, fy: recipe.captureGravity ? `m*(${worldGravity})` : recipe.fy };
}

export const RECIPES: Recipe[] = [
  { name: "Air drag", fx: "-0.5*vx", fy: "-0.5*vy",
    blurb: "Linear resistance opposite velocity in a stationary medium. " +
           "Raise the coefficient 0.5 for stronger drag." },
  { name: "Spring to centre", fx: "-10*x", fy: "-10*y",
    blurb: "A restoring force with stiffness 10 N/m. Set world gravity to 0 " +
           "for oscillations about the origin; gravity shifts the equilibrium." },
  { name: "Gravity well", fx: "-8*x/(r^3+0.2)", fy: "-8*y/(r^3+0.2)",
    blurb: "Central attraction approaching an inverse-square law far from " +
           "the origin. The +0.2 keeps the force finite at the centre." },
  { name: "Vortex", fx: "-4*y/(r+0.2)", fy: "4*x/(r+0.2)",
    blurb: "Pure swirl: the force is always perpendicular to the radius. " +
           "Swap the signs to reverse the torque about the origin." },
  { name: "Cyclone eye", fx: "6*x*exp(-(r/0.7)^4)", fy: "6*y*exp(-(r/0.7)^4)",
    blurb: "A smooth outward push whose exponential weight is 1/e at " +
           "r = 0.7 m and rapidly fades beyond it. This is a soft zone, not a cutoff." },
  { name: "Gusty wind", fx: "3*sin(2*t)+1", fy: "0",
    blurb: "A horizontal force from -2 to 4 N, repeating every pi seconds " +
           "(about 3.14 s). Positive values push right; negative values push left." },
  { name: "Anti-gravity", fx: "0", fy: "m*g", captureGravity: true,
    blurb: "Balances the world's current gravity for every mass. The value " +
           "is captured when added; update Fy after changing gravity." },
  { name: "Quadratic drag", fx: "-0.3*hypot(vx,vy)*vx", fy: "-0.3*hypot(vx,vy)*vy",
    blurb: "Resistance directly opposite velocity in a stationary medium. " +
           "hypot(vx,vy) is speed; the force magnitude is 0.3 times speed squared." },
  { name: "Ceiling push", fx: "0", fy: "-0.4*m*(y > 2)",
    blurb: "Pushes down only above y = 2: the comparison is 1 inside the " +
           "zone and 0 outside. Text editing only." },
  { name: "Blinker", fx: "4 if floor(t) % 2 == 0 else -4", fy: "0",
    blurb: "Alternates a push left and right every second using if/else, " +
           "floor and %. Text editing only." },
];
