<script setup lang="ts">
const model = defineModel<boolean>({ required: true });

defineProps<{ label: string }>();
</script>

<template>
  <label
    class="flex cursor-pointer select-none items-center gap-2 text-[12px] text-zinc-500 transition-colors hover:text-zinc-400"
  >
    <input v-model="model" type="checkbox" class="peer sr-only" />
    <span
      class="relative h-4 w-7 shrink-0 rounded-full bg-zinc-800 ring-1 ring-inset ring-zinc-700/70 transition-colors duration-200 after:absolute after:left-0.5 after:top-0.5 after:h-3 after:w-3 after:rounded-full after:bg-zinc-400 after:shadow-sm after:transition-transform after:duration-200 peer-checked:bg-blue-500 peer-checked:ring-blue-400/40 peer-checked:after:translate-x-3 peer-checked:after:bg-white peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-blue-400"
    />
    {{ label }}
  </label>
</template>
