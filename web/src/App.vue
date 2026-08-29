<script setup lang="ts">
import { useRoute } from 'vue-router';
import { computed } from 'vue';

const route = useRoute();
// Control register (dark) for wall/live; archive (light) everywhere else (M0: wall only).
const register = computed(() => (route.meta.register === 'control' ? 'control' : 'archive'));
</script>

<template>
  <div id="shell" :data-register="register">
    <router-view />
  </div>
</template>

<style>
#shell { height: 100%; }
</style>
