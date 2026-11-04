import { FACE, type Face } from "./face";
import type { BotMood } from "../../contract/models";

/** Mood is the face — eyes, mouth, ears and a little of the posture — never what the body does (A33): the same ball in
 * five faces, with the values chosen in the design study. */
const MOODS: Record<BotMood, Partial<Face>> = {
  normal: {},
  happy: { happy: 1, blush: 1, earL: .16, earR: .16 },
  sad: { lid: .28, lidTilt: -.62, look: [0, -.02], earL: .62, earR: .62, mouth: 6, squash: .97 },
  angry: { lid: .40, lidTilt: 1.1, earL: .56, earR: .56, mouth: 4, look: [0, -.01] },
  dizzy: { kind: 3, mouth: 5, tilt: .08, earL: .10, earR: .46 },
};

export const faceOf = (mood: BotMood): Face => ({ ...FACE, ...MOODS[mood] });
