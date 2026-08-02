import type { ExecutionMascotForm } from "./execution-trace-model"

export const dragonRigParts = [
  "tail",
  "mane",
  "torso",
  "hind-left",
  "hind-right",
  "arm-left",
  "arm-right",
  "head",
  "eye-left",
  "eye-right",
  "eyelids",
  "mouth",
] as const

export type DragonRigPart = (typeof dragonRigParts)[number]

export function dragonRigAsset(form: ExecutionMascotForm, part: DragonRigPart) {
  return `/assets/mascot/form-${form}-rig/${part}.png`
}
