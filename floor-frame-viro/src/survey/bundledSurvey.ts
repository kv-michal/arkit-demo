/**
 * Surveyed reference mode input. No survey ships with the app: surveyed mode
 * stays unavailable until a validated manifest and its printed board images
 * are added here, e.g.
 *
 *   import manifest from "./survey.json";
 *   export const bundledSurvey = { manifest, images: { A: require("./board-a.png") } };
 *
 * The native app reads the same manifest from its bundle (Survey/survey.json).
 */
export const bundledSurvey: { manifest: unknown; images: Record<string, number> } | null = null;
