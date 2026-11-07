export { ServerConnection } from "../../../src/context/server"
import { mockGlobal, mockServer } from "./sdk-fixture"
export const useGlobal = () => mockGlobal
export const useServer = () => mockServer
