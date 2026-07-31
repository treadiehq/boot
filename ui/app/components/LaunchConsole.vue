<script setup lang="ts">
import type { ConsoleLine } from "~/types";

const props = defineProps<{
  lines: ConsoleLine[];
  running: boolean;
  elapsedSeconds: number | null;
}>();

const container = ref<HTMLElement | null>(null);

watch(
  () => props.lines.length,
  async () => {
    await nextTick();
    container.value?.scrollTo({ top: container.value.scrollHeight });
  },
);

const toneClass: Record<ConsoleLine["tone"], string> = {
  ok: "text-emerald-400",
  info: "text-zinc-200",
  dim: "text-zinc-500",
  warn: "text-amber-300",
  error: "text-red-400",
  accent: "text-blue-300",
};
</script>

<template>
  <div
    ref="container"
    class="max-h-72 overflow-y-auto rounded-lg border border-zinc-800/70 bg-black/50 px-4 py-3.5 font-mono text-[12.5px] leading-6"
  >
    <div v-for="(line, index) in lines" :key="index" class="flex gap-2 whitespace-pre-wrap">
      <span class="w-3 shrink-0 select-none" :class="toneClass[line.tone]">{{ line.glyph }}</span>
      <span :class="toneClass[line.tone]">{{ line.text }}</span>
    </div>
    <div v-if="running" class="flex gap-2 text-zinc-500">
      <span class="boot-pulse w-3 select-none">▍</span>
      <span v-if="elapsedSeconds !== null" class="tabular-nums">{{ elapsedSeconds.toFixed(1) }}s</span>
    </div>
  </div>
</template>
