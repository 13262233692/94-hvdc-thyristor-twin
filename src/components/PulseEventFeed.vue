<template>
  <div class="pulse-feed">
    <div class="feed-header">
      <div class="feed-title">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
        </svg>
        触发脉冲事件流
      </div>
      <div class="feed-count">{{ events.length }} / {{ maxEvents }}</div>
    </div>
    
    <div class="feed-content" ref="feedContent">
      <div
        v-for="(event, index) in displayEvents"
        :key="`${event.thyristorId}-${event.timestamp}-${index}`"
        class="event-item"
        :class="{ 'event-new': index === 0 && isRecent(event) }"
      >
        <div class="event-pulse-icon"></div>
        <div class="event-info">
          <div class="event-title">
            晶闸管 #{{ event.thyristorId }}
            <span class="event-level" :style="{ opacity: event.level / 255 }">
              电平: {{ event.level }}
            </span>
          </div>
          <div class="event-meta">
            <span class="event-time">{{ formatTime(event.receivedAt) }}</span>
            <span class="event-location">
              网格:{{ event.meshIndex }} 索引:{{ event.localIndex }}
            </span>
          </div>
        </div>
      </div>
      
      <div v-if="events.length === 0" class="empty-state">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <span>等待触发脉冲信号...</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch, nextTick } from 'vue'

const props = defineProps({
  events: {
    type: Array,
    default: () => []
  },
  maxEvents: {
    type: Number,
    default: 50
  }
})

const feedContent = ref(null)

const displayEvents = computed(() => {
  return props.events.slice(0, props.maxEvents)
})

watch(() => props.events.length, async () => {
  await nextTick()
  if (feedContent.value) {
    feedContent.value.scrollTop = 0
  }
})

const formatTime = (timestamp) => {
  const now = performance.now()
  const diff = now - timestamp
  if (diff < 1000) {
    return `${Math.round(diff)}ms 前`
  }
  return `${(diff / 1000).toFixed(1)}s 前`
}

const isRecent = (event) => {
  return performance.now() - event.receivedAt < 500
}
</script>

<style scoped>
.pulse-feed {
  position: absolute;
  top: 20px;
  right: 20px;
  width: 360px;
  max-height: 400px;
  background: rgba(15, 23, 42, 0.92);
  backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 107, 107, 0.2);
  border-radius: 12px;
  overflow: hidden;
  z-index: 100;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

.feed-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: linear-gradient(135deg, rgba(255, 107, 107, 0.1), rgba(255, 60, 60, 0.05));
  border-bottom: 1px solid rgba(255, 107, 107, 0.15);
}

.feed-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: #ff6b6b;
}

.feed-count {
  font-size: 11px;
  color: #64748b;
  font-family: 'Consolas', monospace;
}

.feed-content {
  max-height: 340px;
  overflow-y: auto;
  padding: 8px;
}

.event-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  margin-bottom: 4px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 8px;
  border: 1px solid transparent;
  transition: all 0.3s;
}

.event-item.event-new {
  border-color: rgba(255, 107, 107, 0.5);
  background: rgba(255, 107, 107, 0.1);
  animation: slideIn 0.3s ease-out;
}

@keyframes slideIn {
  from {
    opacity: 0;
    transform: translateX(20px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

.event-pulse-icon {
  width: 12px;
  height: 12px;
  margin-top: 4px;
  border-radius: 50%;
  background: #ff6b6b;
  flex-shrink: 0;
  box-shadow: 0 0 12px rgba(255, 107, 107, 0.8);
  animation: pulse 1s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.3); }
}

.event-info {
  flex: 1;
  min-width: 0;
}

.event-title {
  font-size: 13px;
  font-weight: 500;
  color: #e0e6ed;
  display: flex;
  align-items: center;
  gap: 8px;
}

.event-level {
  font-size: 11px;
  color: #ff6b6b;
  font-family: 'Consolas', monospace;
}

.event-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 4px;
  font-size: 11px;
  color: #64748b;
}

.event-time {
  color: #00c8ff;
  font-family: 'Consolas', monospace;
}

.event-location {
  font-family: 'Consolas', monospace;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  color: #475569;
  gap: 12px;
}

.empty-state svg {
  opacity: 0.5;
}

.empty-state span {
  font-size: 13px;
}
</style>
