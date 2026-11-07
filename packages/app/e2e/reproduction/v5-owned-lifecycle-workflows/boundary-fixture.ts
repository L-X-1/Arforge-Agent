import { mockGlobal,mockServer } from "./sdk-fixture"
export * from "../../../src/context/server"
export const useGlobal=()=>mockGlobal
export const useServer=()=>mockServer
