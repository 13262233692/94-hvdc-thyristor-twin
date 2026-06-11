<template>
  <div class="control-panel">
    <div class="panel-header">
      <div class="panel-title">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
          <line x1="9" y1="9" x2="15" y2="9"/>
          <line x1="9" y1="15" x2="15" y2="15"/>
        </svg>
        换流阀监控控制台
      </div>
    </div>

    <div class="panel-section">
      <div class="section-title">连接控制</div>
      
      <div class="status-indicator" :class="{ connected, error: !connected && !loading }">
        <span class="status-dot"></span>
        <span class="status-text">
          {{ connected ? 'SV 流已连接' : '未连接' }}
        </span>
      </div>

      <div class="input-group">
        <label>WebSocket 地址</label>
        <input
          v-model="wsUrl"
          type="text"
          placeholder="ws://localhost:8080/sv"
          class="input-field"
          :disabled="connected"
        />
      </div>

      <div class="button-group">
        <button
          class="btn btn-primary"
          :disabled="connected || loading"
          @click="handleConnect"
        >
          连接 SV 流
        </button>
        <button
          class="btn btn-secondary"
          :disabled="!connected"
          @click="$emit('disconnect')"
        >
          断开连接
        </button>
      </div>

      <button
        class="btn btn-demo"
        :disabled="connected"
        @click="$emit('start-simulation')"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="5 3 19 12 5 21 5 3"/>
        </svg>
        启动模拟数据
      </button>
    </div>

    <div class="panel-section">
      <div class="section-title">模型加载</div>
      
      <div class="input-group">
        <label>GLTF 模型路径</label>
        <input
          v-model="modelUrl"
          type="text"
          placeholder="/models/valve-tower.glb"
          class="input-field"
          :disabled="loading"
        />
      </div>

      <div class="button-group">
        <button
          class="btn btn-primary"
          :disabled="loading"
          @click="handleLoadModel"
        >
          加载 GLTF 模型
        </button>
        <button
          class="btn btn-secondary"
          :disabled="loading"
          @click="$emit('load-demo')"
        >
          加载演示模型
        </button>
      </div>
    </div>

    <div v-if="modelStats" class="panel-section">
      <div class="section-title">模型信息</div>
      <div class="stats-grid">
        <div class="stat-item">
          <div class="stat-label">晶闸管总数</div>
          <div class="stat-value">{{ formatNumber(modelStats.thyristorCount) }}</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">优化前 Draw Call</div>
          <div class="stat-value stat-warning">{{ formatNumber(modelStats.drawCallsBefore) }}</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">优化后 Draw Call</div>
          <div class="stat-value stat-success">{{ formatNumber(modelStats.drawCallsAfter) }}</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">总顶点数</div>
          <div class="stat-value">{{ formatNumber(modelStats.totalVertices) }}</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">总三角形数</div>
          <div class="stat-value">{{ formatNumber(modelStats.totalTriangles) }}</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">网格对象数</div>
          <div class="stat-value">{{ formatNumber(modelStats.totalMeshes) }}</div>
        </div>
      </div>
    </div>

    <div class="panel-section">
      <div class="section-title">性能指标</div>
      <div class="stats-grid">
        <div class="stat-item">
          <div class="stat-label">帧率 FPS</div>
          <div class="stat-value" :class="fpsClass">{{ stats.fps }}</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">当前 Draw Call</div>
          <div class="stat-value">{{ formatNumber(stats.drawCalls) }}</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">渲染三角形</div>
          <div class="stat-value">{{ formatNumber(stats.triangles) }}</div>
        </div>
      </div>
    </div>

    <div class="panel-section">
      <div class="section-title">脉冲统计</div>
      <div class="stats-grid">
        <div class="stat-item">
          <div class="stat-label">触发脉冲总数</div>
          <div class="stat-value pulse-value">{{ formatNumber(pulseStats.totalPulses) }}</div>
        </div>
        <div class="stat-item">
          <div class="stat-label">脉冲速率 (个/秒)</div>
          <div class="stat-value pulse-value">{{ pulseStats.pulseRate.toFixed(1) }}</div>
        </div>
      </div>
    </div>

    <div class="panel-section">
      <div class="section-title">通信模式</div>
      <div class="comm-status" :class="{ active: zeroCopyMode }">
        <span class="comm-indicator"></span>
        <div class="comm-info">
          <div class="comm-title">
            {{ zeroCopyMode ? 'SharedArrayBuffer 零拷贝' : '结构化克隆 (Structured Clone)' }}
          </div>
          <div class="comm-desc">
            {{ zeroCopyMode ? '⚡ 极速零内存拷贝，Atomics 同步' : '⚠️ 4kHz 高频下可能导致 GC 卡顿' }}
          </div>
        </div>
      </div>
    </div>

    <div class="panel-section info-section">
      <div class="info-title">技术架构</div>
      <ul class="info-list">
        <li><span class="badge">Vue3</span> 响应式 UI 框架</li>
        <li><span class="badge">Three.js</span> WebGL 渲染引擎</li>
        <li><span class="badge">InstancedMesh</span> 实例化渲染</li>
        <li><span class="badge">WebWorker</span> SV 流解析</li>
        <li><span class="badge">Shader</span> 脉冲高亮效果</li>
        <li><span class="badge">Bloom</span> 辉光后期处理</li>
      </ul>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'

const props = defineProps({
  connected: {
    type: Boolean,
    default: false
  },
  loading: {
    type: Boolean,
    default: false
  },
  zeroCopyMode: {
    type: Boolean,
    default: false
  },
  stats: {
    type: Object,
    default: () => ({ fps: 0, drawCalls: 0, triangles: 0 })
  },
  modelStats: {
    type: Object,
    default: null
  },
  pulseStats: {
    type: Object,
    default: () => ({ totalPulses: 0, pulseRate: 0 })
  }
})

const emit = defineEmits(['connect', 'disconnect', 'start-simulation', 'load-model', 'load-demo'])

const wsUrl = ref('ws://localhost:8080/sv')
const modelUrl = ref('/models/valve-tower.glb')

const fpsClass = computed(() => {
  if (props.stats.fps >= 55) return 'stat-success'
  if (props.stats.fps >= 30) return 'stat-warning'
  return 'stat-error'
})

const handleConnect = () => {
  emit('connect', { wsUrl: wsUrl.value })
}

const handleLoadModel = () => {
  emit('load-model', modelUrl.value)
}

const formatNumber = (num) => {
  if (num >= 1000000) return (num / 1000000).toFixed(2) + 'M'
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K'
  return num?.toLocaleString() || '0'
}
</script>

<style scoped>
.control-panel {
  position: absolute;
  top: 20px;
  left: 20px;
  width: 340px;
  max-height: calc(100vh - 100px);
  background: rgba(15, 23, 42, 0.92);
  backdrop-filter: blur(16px);
  border: 1px solid rgba(0, 200, 255, 0.2);
  border-radius: 12px;
  overflow-y: auto;
  overflow-x: hidden;
  z-index: 100;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

.panel-header {
  padding: 16px 20px;
  background: linear-gradient(135deg, rgba(0, 200, 255, 0.1), rgba(0, 150, 255, 0.05));
  border-bottom: 1px solid rgba(0, 200, 255, 0.15);
}

.panel-title {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 16px;
  font-weight: 600;
  color: #00c8ff;
}

.panel-section {
  padding: 16px 20px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}

.section-title {
  font-size: 12px;
  font-weight: 600;
  color: #94a3b8;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 12px;
}

.status-indicator {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  border-radius: 8px;
  margin-bottom: 16px;
}

.status-indicator.connected {
  background: rgba(34, 197, 94, 0.1);
  border-color: rgba(34, 197, 94, 0.3);
}

.status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #ef4444;
  animation: blink 1.5s ease-in-out infinite;
}

.status-indicator.connected .status-dot {
  background: #22c55e;
}

@keyframes blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.status-text {
  font-size: 14px;
  color: #e0e6ed;
}

.input-group {
  margin-bottom: 12px;
}

.input-group label {
  display: block;
  font-size: 12px;
  color: #94a3b8;
  margin-bottom: 6px;
}

.input-field {
  width: 100%;
  padding: 10px 12px;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  color: #e0e6ed;
  font-size: 13px;
  font-family: inherit;
  transition: all 0.2s;
}

.input-field:focus {
  outline: none;
  border-color: #00c8ff;
  box-shadow: 0 0 0 3px rgba(0, 200, 255, 0.15);
}

.input-field:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.button-group {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.btn {
  flex: 1;
  padding: 10px 16px;
  border: none;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-family: inherit;
}

.btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.btn-primary {
  background: linear-gradient(135deg, #00c8ff, #0099ff);
  color: white;
}

.btn-primary:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 200, 255, 0.4);
}

.btn-secondary {
  background: rgba(255, 255, 255, 0.1);
  color: #e0e6ed;
  border: 1px solid rgba(255, 255, 255, 0.2);
}

.btn-secondary:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.15);
}

.btn-demo {
  width: 100%;
  background: linear-gradient(135deg, #8b5cf6, #6366f1);
  color: white;
}

.btn-demo:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(139, 92, 246, 0.4);
}

.stats-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.stat-item {
  padding: 10px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 6px;
}

.stat-label {
  font-size: 11px;
  color: #64748b;
  margin-bottom: 4px;
}

.stat-value {
  font-size: 16px;
  font-weight: 600;
  color: #e0e6ed;
  font-family: 'Consolas', monospace;
}

.stat-success {
  color: #22c55e;
}

.stat-warning {
  color: #f59e0b;
}

.stat-error {
  color: #ef4444;
}

.pulse-value {
  color: #ff6b6b;
}

.comm-status {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: rgba(245, 158, 11, 0.08);
  border: 1px solid rgba(245, 158, 11, 0.25);
  border-radius: 8px;
}

.comm-status.active {
  background: rgba(0, 255, 136, 0.08);
  border-color: rgba(0, 255, 136, 0.3);
}

.comm-indicator {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #f59e0b;
  flex-shrink: 0;
}

.comm-status.active .comm-indicator {
  background: #00ff88;
  animation: pulse-comm 1.5s ease-in-out infinite;
}

@keyframes pulse-comm {
  0%, 100% { box-shadow: 0 0 0 0 rgba(0, 255, 136, 0.5); }
  50% { box-shadow: 0 0 0 6px rgba(0, 255, 136, 0); }
}

.comm-info {
  flex: 1;
  min-width: 0;
}

.comm-title {
  font-size: 13px;
  font-weight: 600;
  color: #e0e6ed;
}

.comm-desc {
  font-size: 11px;
  color: #64748b;
  margin-top: 2px;
}

.info-section {
  background: rgba(0, 0, 0, 0.2);
}

.info-title {
  font-size: 12px;
  font-weight: 600;
  color: #94a3b8;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 12px;
}

.info-list {
  list-style: none;
  padding: 0;
  margin: 0;
}

.info-list li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 0;
  font-size: 12px;
  color: #94a3b8;
}

.badge {
  display: inline-block;
  padding: 2px 8px;
  background: rgba(0, 200, 255, 0.15);
  color: #00c8ff;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
}
</style>
