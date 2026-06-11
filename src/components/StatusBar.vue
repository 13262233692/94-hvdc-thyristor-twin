<template>
  <div class="status-bar">
    <div class="status-left">
      <div class="status-item">
        <span class="label">FPS</span>
        <span class="value" :class="fpsClass">{{ fps }}</span>
      </div>
      <div class="status-separator"></div>
      <div class="status-item">
        <span class="label">Draw Call</span>
        <span class="value">{{ formatNumber(drawCalls) }}</span>
      </div>
      <div class="status-separator"></div>
      <div class="status-item">
        <span class="label">三角形</span>
        <span class="value">{{ formatNumber(triangles) }}</span>
      </div>
    </div>
    
    <div class="status-center">
      <div class="status-item" :class="{ pulse: pulseActive }">
        <span class="label">触发脉冲</span>
        <span class="value pulse-value">{{ formatNumber(totalPulses) }}</span>
        <span class="pulse-indicator" v-if="pulseActive"></span>
      </div>
    </div>

    <div class="status-right">
      <div class="status-item">
        <span class="label">脉冲速率</span>
        <span class="value">{{ pulseRate.toFixed(1) }}/s</span>
      </div>
      <div class="status-separator"></div>
      <div class="status-item">
        <span class="connection-indicator" :class="{ connected }"></span>
        <span class="connection-text">{{ connected ? 'SV 已连接' : '未连接' }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'

const props = defineProps({
  fps: {
    type: Number,
    default: 0
  },
  drawCalls: {
    type: Number,
    default: 0
  },
  triangles: {
    type: Number,
    default: 0
  },
  connected: {
    type: Boolean,
    default: false
  },
  totalPulses: {
    type: Number,
    default: 0
  },
  pulseRate: {
    type: Number,
    default: 0
  }
})

const pulseActive = ref(false)
let pulseTimeout = null

watch(() => props.totalPulses, (newVal, oldVal) => {
  if (newVal > oldVal) {
    pulseActive.value = true
    if (pulseTimeout) clearTimeout(pulseTimeout)
    pulseTimeout = setTimeout(() => {
      pulseActive.value = false
    }, 500)
  }
})

const fpsClass = computed(() => {
  if (props.fps >= 55) return 'good'
  if (props.fps >= 30) return 'medium'
  return 'low'
})

const formatNumber = (num) => {
  if (num >= 1000000) return (num / 1000000).toFixed(2) + 'M'
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K'
  return num?.toLocaleString() || '0'
}
</script>

<style scoped>
.status-bar {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 48px;
  background: rgba(15, 23, 42, 0.95);
  backdrop-filter: blur(16px);
  border-top: 1px solid rgba(0, 200, 255, 0.2);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  z-index: 100;
}

.status-left,
.status-center,
.status-right {
  display: flex;
  align-items: center;
  gap: 16px;
}

.status-item {
  display: flex;
  align-items: center;
  gap: 8px;
  position: relative;
}

.status-item.pulse {
  animation: pulseGlow 0.5s ease-out;
}

@keyframes pulseGlow {
  0%, 100% { text-shadow: none; }
  50% { text-shadow: 0 0 20px rgba(255, 107, 107, 0.8); }
}

.label {
  font-size: 11px;
  color: #64748b;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.value {
  font-size: 14px;
  font-weight: 600;
  color: #e0e6ed;
  font-family: 'Consolas', monospace;
  min-width: 40px;
}

.value.good {
  color: #22c55e;
}

.value.medium {
  color: #f59e0b;
}

.value.low {
  color: #ef4444;
}

.value.pulse-value {
  color: #ff6b6b;
}

.status-separator {
  width: 1px;
  height: 20px;
  background: rgba(255, 255, 255, 0.1);
}

.connection-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ef4444;
}

.connection-indicator.connected {
  background: #22c55e;
  animation: blink 1.5s ease-in-out infinite;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.connection-text {
  font-size: 13px;
  color: #94a3b8;
}

.pulse-indicator {
  position: absolute;
  top: -4px;
  right: -8px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #ff6b6b;
  animation: pulseFlash 0.5s ease-out;
}

@keyframes pulseFlash {
  0% { transform: scale(1); opacity: 1; }
  100% { transform: scale(3); opacity: 0; }
}
</style>
