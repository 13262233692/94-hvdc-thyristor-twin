<template>
  <div v-if="warnings.length > 0" class="thermal-warning-panel">
    <div class="warning-header" :class="headerClass">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
        <line x1="12" y1="9" x2="12" y2="13"/>
        <line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
      热击穿预警
    </div>
    <div class="warning-list">
      <div
        v-for="(w, i) in displayWarnings"
        :key="i"
        class="warning-item"
        :class="getLevelClass(w.level)"
      >
        <span class="warning-level-dot"></span>
        <div class="warning-info">
          <div class="warning-title">
            晶闸管 #{{ w.thyristorId }}
            <span class="warning-level-badge">{{ w.levelName }}</span>
          </div>
          <div class="warning-temp">{{ w.temperature }}°C</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  warnings: {
    type: Array,
    default: () => []
  },
  maxTemp: {
    type: Number,
    default: 25
  }
})

const displayWarnings = computed(() => {
  return props.warnings.slice(0, 8)
})

const headerClass = computed(() => {
  if (!props.warnings.length) return ''
  const maxLevel = Math.max(...props.warnings.map(w => w.level))
  if (maxLevel >= 4) return 'header-meltdown'
  if (maxLevel >= 3) return 'header-critical'
  if (maxLevel >= 2) return 'header-warning'
  return 'header-caution'
})

const getLevelClass = (level) => {
  const classes = ['level-normal', 'level-caution', 'level-warning', 'level-critical', 'level-meltdown']
  return classes[level] || 'level-normal'
}
</script>

<style scoped>
.thermal-warning-panel {
  position: absolute;
  bottom: 60px;
  left: 380px;
  width: 280px;
  max-height: 300px;
  background: rgba(15, 10, 10, 0.95);
  backdrop-filter: blur(16px);
  border: 1px solid rgba(239, 68, 68, 0.4);
  border-radius: 12px;
  overflow: hidden;
  z-index: 100;
  box-shadow: 0 0 30px rgba(239, 68, 68, 0.2);
}

.warning-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  color: #f59e0b;
  font-size: 13px;
  font-weight: 600;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.header-caution { background: rgba(245, 158, 11, 0.1); color: #f59e0b; }
.header-warning { background: rgba(255, 165, 0, 0.15); color: #ff8c00; }
.header-critical { background: rgba(239, 68, 68, 0.15); color: #ef4444; animation: criticalFlash 1s ease-in-out infinite; }
.header-meltdown { background: rgba(255, 0, 0, 0.2); color: #ff0000; animation: meltdownFlash 0.5s ease-in-out infinite; }

@keyframes criticalFlash {
  0%, 100% { background: rgba(239, 68, 68, 0.15); }
  50% { background: rgba(239, 68, 68, 0.3); }
}

@keyframes meltdownFlash {
  0%, 100% { background: rgba(255, 0, 0, 0.2); }
  50% { background: rgba(255, 0, 0, 0.4); }
}

.warning-list {
  max-height: 250px;
  overflow-y: auto;
  padding: 8px;
}

.warning-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  margin-bottom: 4px;
  background: rgba(0, 0, 0, 0.2);
}

.warning-level-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}

.level-caution .warning-level-dot { background: #f59e0b; }
.level-warning .warning-level-dot { background: #ff8c00; }
.level-critical .warning-level-dot { background: #ef4444; animation: dotPulse 0.5s ease-in-out infinite; }
.level-meltdown .warning-level-dot { background: #ff0000; box-shadow: 0 0 8px #ff0000; animation: dotPulse 0.3s ease-in-out infinite; }

@keyframes dotPulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.5); }
}

.warning-info {
  flex: 1;
  min-width: 0;
}

.warning-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #e0e6ed;
}

.warning-level-badge {
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 10px;
  font-weight: 600;
}

.level-caution .warning-level-badge { background: rgba(245, 158, 11, 0.2); color: #f59e0b; }
.level-warning .warning-level-badge { background: rgba(255, 140, 0, 0.2); color: #ff8c00; }
.level-critical .warning-level-badge { background: rgba(239, 68, 68, 0.2); color: #ef4444; }
.level-meltdown .warning-level-badge { background: rgba(255, 0, 0, 0.3); color: #ff0000; }

.warning-temp {
  font-size: 14px;
  font-weight: 700;
  color: #ef4444;
  font-family: 'Consolas', monospace;
  margin-top: 2px;
}
</style>
