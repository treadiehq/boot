<script setup lang="ts">
import type { EnvironmentStatus, RequirementStatus } from "~/types";

const props = defineProps<{
  tools: RequirementStatus[];
  services: RequirementStatus[];
  environment: EnvironmentStatus[];
}>();

interface RowData {
  kind: string;
  name: string;
  required: string;
  status: string;
  tone: "ok" | "warn" | "error" | "dim";
}

const rows = computed<RowData[]>(() => {
  const list: RowData[] = [];
  for (const tool of props.tools) list.push(requirementRow("tool", tool));
  for (const service of props.services) list.push(requirementRow("service", service));
  for (const env of props.environment) {
    list.push({
      kind: "env",
      name: env.name,
      required: env.secret ? "secret" : "",
      status: env.available
        ? env.availableFrom === "boot"
          ? "available from encrypted storage"
          : "available from process"
        : "missing",
      tone: env.available ? "ok" : "error",
    });
  }
  return list;
});

function requirementRow(kind: string, requirement: RequirementStatus): RowData {
  const tone =
    requirement.state === "available"
      ? "ok"
      : requirement.state === "mismatch"
        ? "warn"
        : requirement.state === "unsupported"
          ? "dim"
          : "error";
  return {
    kind,
    name: requirement.name,
    required: requirement.required ?? "",
    status:
      requirement.state === "available"
        ? (requirement.observed ?? "available")
        : (requirement.detail ?? requirement.state),
    tone,
  };
}

const dotClass: Record<RowData["tone"], string> = {
  ok: "bg-emerald-400",
  warn: "bg-amber-300",
  error: "bg-red-400",
  dim: "bg-zinc-600",
};
const statusClass: Record<RowData["tone"], string> = {
  ok: "text-zinc-500",
  warn: "text-amber-300/90",
  error: "text-red-400/90",
  dim: "text-zinc-500",
};
</script>

<template>
  <div
    v-if="rows.length > 0"
    class="divide-y divide-zinc-800/50 overflow-hidden rounded-xl border border-zinc-800/80 bg-zinc-900/30"
  >
    <div
      v-for="row in rows"
      :key="`${row.kind}:${row.name}`"
      class="flex items-center gap-3 px-4 py-2.5"
    >
      <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="dotClass[row.tone]" />
      <span class="w-14 shrink-0 font-mono text-[10px] uppercase tracking-wider text-zinc-600">
        {{ row.kind }}
      </span>
      <span class="shrink-0 font-mono text-[13px] text-zinc-200">{{ row.name }}</span>
      <span v-if="row.required" class="shrink-0 font-mono text-[12px] text-zinc-500">
        {{ row.required }}
      </span>
      <span class="ml-auto min-w-0 truncate text-right text-[12px]" :class="statusClass[row.tone]">
        {{ row.status }}
      </span>
    </div>
  </div>
</template>
