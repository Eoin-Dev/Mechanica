/** Exam-style elastic-link quantities from authored Hooke parameters.
 * These diagnostics do not reuse the previous step's effective coefficients. */
import { SpringLink } from "../engine/links";

/** The mechanics modulus λ is in newtons: λ = k l, with natural length l > 0. */
export function elasticModulus(link: SpringLink): number | null {
  if (!Number.isFinite(link.restLength) || link.restLength <= 0 ||
      !Number.isFinite(link.stiffness) || link.stiffness < 0) return null;
  const modulus = link.stiffness * link.restLength;
  return Number.isFinite(modulus) ? modulus : null;
}

/** Convert λ/l within the existing scene stiffness bounds, without clamping. */
export function stiffnessForModulus(modulus: number, naturalLength: number): number | null {
  if (!Number.isFinite(modulus) || modulus < 0 ||
      !Number.isFinite(naturalLength) || naturalLength <= 0) return null;
  const stiffness = modulus / naturalLength;
  return Number.isFinite(stiffness) && stiffness <= 1e9 ? stiffness : null;
}

export interface ElasticAnalysis {
  length: number;
  extension: number;
  /** Signed axial elastic force; positive is tension, negative is thrust. */
  force: number;
  energy: number;
  state: "taut" | "slack" | "stretched" | "compressed" | "natural";
}

/** Ideal authored force and energy, excluding damping and solver approximations. */
export function analyseElasticLink(link: SpringLink): ElasticAnalysis {
  const length = link.a.pos.distTo(link.b.pos);
  const extension = length - link.restLength;
  const activeExtension = link.tensionOnly ? Math.max(0, extension) : extension;
  return {
    length,
    extension,
    force: link.stiffness * activeExtension,
    energy: 0.5 * link.stiffness * activeExtension * activeExtension,
    state: link.tensionOnly ? (extension > 0 ? "taut" : "slack")
      : extension > 0 ? "stretched" : extension < 0 ? "compressed" : "natural",
  };
}
