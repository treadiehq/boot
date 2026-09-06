import { z } from "zod";

export const sessionRuntimeSchema = z.object({
  schemaVersion: z.literal(1), token: z.string().uuid(),
  daemon: z.string().nullable(), network: z.string().nullable(),
  ports: z.array(z.object({ id: z.string(), env: z.string(), port: z.number().int().min(1024).max(65535) }).strict()),
  databases: z.array(z.object({
    id: z.string(), env: z.string(), version: z.enum(["16", "17"]),
    container: z.string(), containerId: z.string().nullable(), volume: z.string(),
    port: z.number().int().min(1).max(65535).nullable(),
  }).strict()),
}).strict();
export type SessionRuntime = z.infer<typeof sessionRuntimeSchema>;
