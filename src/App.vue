<template>
  <div class="app-container">
    <div ref="sceneContainer" class="scene-container"></div>
    
    <ControlPanel
      :connected="svConnected"
      :loading="modelLoading"
      :stats="renderStats"
      :modelStats="modelStats"
      :pulseStats="pulseStats"
      :zero-copy-mode="zeroCopyMode"
      @connect="handleConnect"
      @disconnect="handleDisconnect"
      @start-simulation="handleStartSimulation"
      @load-model="handleLoadModel"
      @load-demo="handleLoadDemo"
    />

    <StatusBar
      :fps="renderStats.fps"
      :draw-calls="renderStats.drawCalls"
      :triangles="renderStats.triangles"
      :connected="svConnected"
      :total-pulses="pulseStats.totalPulses"
      :pulse-rate="pulseStats.pulseRate"
    />

    <div v-if="modelLoading" class="loading-overlay">
      <div class="loading-content">
        <div class="loading-spinner"></div>
        <div class="loading-text">加载换流阀 3D 模型中...</div>
        <div class="loading-progress">{{ loadingProgress.toFixed(1) }}%</div>
      </div>
    </div>

    <PulseEventFeed
      :events="recentPulseEvents"
      :max-events="50"
    />

    <div class="thermal-control-panel">
      <div class="thermal-header">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/>
        </svg>
        热传导仿真引擎
      </div>

      <div class="thermal-stats">
        <div class="thermal-stat">
          <span class="thermal-label">最高温度</span>
          <span class="thermal-value" :class="tempWarningClass">{{ thermalStats.maxTemp.toFixed(1) }}°C</span>
        </div>
        <div class="thermal-stat">
          <span class="thermal-label">平均温度</span>
          <span class="thermal-value">{{ thermalStats.avgTemp.toFixed(1) }}°C</span>
        </div>
        <div class="thermal-stat">
          <span class="thermal-label">求解步率</span>
          <span class="thermal-value">{{ thermalStats.stepsPerSecond }}/s</span>
        </div>
        <div class="thermal-stat">
          <span class="thermal-label">预警数</span>
          <span class="thermal-value" :class="{ 'text-danger': thermalStats.warningCount > 0 }">{{ thermalStats.warningCount }}</span>
        </div>
      </div>

      <div class="thermal-controls">
        <button class="btn-thermal" :class="{ active: thermalEnabled }" @click="toggleThermalVisualization">
          {{ thermalEnabled ? '🟢 热图已启用' : '⚫ 启用红外热图' }}
        </button>
        <button class="btn-thermal" :class="{ active: heatSimRunning }" @click="heatSimRunning ? stopHeatSimulation() : startHeatSimulation()">
          {{ heatSimRunning ? '⏸ 暂停求解' : '▶ 启动求解器' }}
        </button>
        <button class="btn-thermal btn-heat" @click="injectGlobalHeat(2.0)">
          🔥 注入 I²R 热源
        </button>
        <button class="btn-thermal btn-block" @click="simulateCoolantBlockage()">
          🧊 模拟冷却堵塞
        </button>
        <button class="btn-thermal btn-restore" @click="restoreCoolant()">
          💧 恢复冷却流通
        </button>
      </div>

      <div class="thermal-legend">
        <div class="legend-bar"></div>
        <div class="legend-labels">
          <span>{{ HEAT_CONFIG.AMBIENT_TEMP }}°C</span>
          <span>{{ HEAT_CONFIG.WARNING_TEMP }}°C</span>
          <span>{{ HEAT_CONFIG.CRITICAL_TEMP }}°C</span>
          <span>{{ HEAT_CONFIG.MELTDOWN_TEMP }}°C</span>
        </div>
      </div>
    </div>

    <ThermalWarningPanel
      :warnings="thermalWarnings"
      :max-temp="thermalStats.maxTemp"
    />

    <div v-if="zeroCopyMode" class="zero-copy-badge">
      <span class="badge-icon">⚡</span>
      SharedArrayBuffer 零拷贝模式
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, onUnmounted, computed } from 'vue'
import SceneManager from './core/SceneManager.js'
import SVStreamManager from './core/SVStreamManager.js'
import HeatSimManager from './core/HeatSimManager.js'
import { IEC61850_CONFIG } from './core/constants.js'
import { HEAT_CONFIG, WARNING_LEVEL } from './core/HeatConstants.js'
import ControlPanel from './components/ControlPanel.vue'
import StatusBar from './components/StatusBar.vue'
import PulseEventFeed from './components/PulseEventFeed.vue'
import ThermalWarningPanel from './components/ThermalWarningPanel.vue'

const sceneContainer = ref(null)

let sceneManager = null
let svStreamManager = null
let heatSimManager = null

const tempWarningClass = computed(() => {
  const t = thermalStats.maxTemp
  if (t >= HEAT_CONFIG.MELTDOWN_TEMP) return 'text-meltdown'
  if (t >= HEAT_CONFIG.CRITICAL_TEMP) return 'text-critical'
  if (t >= HEAT_CONFIG.WARNING_TEMP) return 'text-warning'
  return 'text-normal'
})

const modelLoading = ref(false)
const loadingProgress = ref(0)
const svConnected = ref(false)
const zeroCopyMode = ref(false)
const thermalEnabled = ref(false)
const heatSimRunning = ref(false)
const thermalStats = reactive({
  maxTemp: HEAT_CONFIG.AMBIENT_TEMP,
  avgTemp: HEAT_CONFIG.AMBIENT_TEMP,
  stepsPerSecond: 0,
  warningCount: 0
})
const thermalWarnings = ref([])
const recentPulseEvents = ref([])
const eventsPool = []
for (let i = 0; i < 512; i++) {
  eventsPool.push({
    thyristorId: 0, level: 0, meshIndex: 0, localIndex: 0,
    isBurst: false, timestamp: 0, receivedAt: 0
  })
}
let poolCursor = 0

const renderStats = reactive({
  fps: 0,
  drawCalls: 0,
  triangles: 0
})

const modelStats = reactive({
  totalMeshes: 0,
  totalVertices: 0,
  totalTriangles: 0,
  thyristorCount: 0,
  drawCallsBefore: 0,
  drawCallsAfter: 0
})

const pulseStats = reactive({
  totalPulses: 0,
  pulseRate: 0
})

const handleConnect = async (config) => {
  if (!svStreamManager) {
    await initSVStream()
  }
  svStreamManager.connect(config)
}

const handleDisconnect = () => {
  if (svStreamManager) {
    svStreamManager.disconnect()
  }
}

const handleStartSimulation = async () => {
  if (!svStreamManager) {
    await initSVStream()
  }
  svStreamManager.connect({ simulate: true })
}

const handleLoadModel = async (url) => {
  if (!sceneManager) return
  
  modelLoading.value = true
  loadingProgress.value = 0
  
  try {
    await sceneManager.loadModel(url)
  } catch (error) {
    console.error('加载模型失败:', error)
  } finally {
    modelLoading.value = false
  }
}

const handleLoadDemo = () => {
  if (!sceneManager) return
  
  modelLoading.value = true
  loadingProgress.value = 50
  
  setTimeout(() => {
    sceneManager.loadDemoModel(IEC61850_CONFIG.THYRISTOR_COUNT)
    modelLoading.value = false
    loadingProgress.value = 100
  }, 500)
}

const initSVStream = async () => {
  const instanceIdMap = sceneManager?.getInstanceIdMap() || new Map()
  
  svStreamManager = new SVStreamManager({
    thyristorCount: IEC61850_CONFIG.THYRISTOR_COUNT,
    instanceIdMap
  })

  await svStreamManager.init()

  zeroCopyMode.value = svStreamManager.zeroCopyMode

  if (zeroCopyMode.value) {
    const pulseBuffer = svStreamManager.getPulseStateBuffer()
    if (pulseBuffer && sceneManager) {
      sceneManager.setPulseStateBuffer(pulseBuffer)
    }
  }

  svStreamManager.on('status', (data) => {
    if (data.connected !== undefined) {
      svConnected.value = data.connected
    }
    if (data.zeroCopy !== undefined) {
      zeroCopyMode.value = data.zeroCopy
    }
  })

  svStreamManager.on('pulse', (data) => {
    if (!zeroCopyMode.value) {
      sceneManager?.handlePulseEvents(data.events)
    }

    if (heatSimManager && heatSimRunning.value) {
      heatSimManager.injectPulseHeat(data.events)
    }
    
    const now = performance.now()
    const count = Math.min(data.count, 20)
    const displayEvents = []
    
    for (let i = 0; i < count; i++) {
      if (poolCursor >= eventsPool.length) poolCursor = 0
      const evt = eventsPool[poolCursor++]
      const src = data.events[i]
      evt.thyristorId = src.thyristorId
      evt.level = src.level
      evt.meshIndex = src.meshIndex
      evt.localIndex = src.localIndex
      evt.isBurst = src.isBurst
      evt.timestamp = src.timestamp
      evt.receivedAt = now
      displayEvents.push(evt)
    }
    
    recentPulseEvents.value = [
      ...displayEvents,
      ...recentPulseEvents.value
    ].slice(0, 100)

    const stats = svStreamManager.getStats()
    pulseStats.totalPulses = stats.totalPulses
    pulseStats.pulseRate = stats.pulseRatePerSecond
  })

  svStreamManager.on('error', (error) => {
    console.error('SV 流错误:', error)
  })
}

onMounted(async () => {
  sceneManager = new SceneManager(sceneContainer.value, {
    enablePostProcessing: true,
    enableBloom: true,
    enableShadow: true
  })

  sceneManager.onStatsUpdate = (stats) => {
    renderStats.fps = stats.fps
    renderStats.drawCalls = stats.drawCalls
    renderStats.triangles = stats.triangles
  }

  sceneManager.onLoadingProgress = (percent) => {
    loadingProgress.value = percent
  }

  sceneManager.onModelLoad = async (info) => {
    if (info && info.stats) {
      Object.assign(modelStats, info.stats)
    }
    
    if (!svStreamManager) {
      await initSVStream()
    } else {
      svStreamManager.instanceIdMap = sceneManager.getInstanceIdMap()
    }

    if (!heatSimManager) {
      await initHeatSim()
    }
  }

  sceneManager.start()

  handleLoadDemo()
})

onUnmounted(() => {
  if (heatSimManager) {
    heatSimManager.dispose()
    heatSimManager = null
  }
  if (svStreamManager) {
    svStreamManager.dispose()
    svStreamManager = null
  }
  
  if (sceneManager) {
    sceneManager.dispose()
    sceneManager = null
  }
})

const initHeatSim = async () => {
  const thyristorCount = sceneManager?.getThyristorCount() || IEC61850_CONFIG.THYRISTOR_COUNT
  
  heatSimManager = new HeatSimManager({ thyristorCount })
  await heatSimManager.init(thyristorCount)
  
  if (sceneManager) {
    sceneManager.setHeatSimManager(heatSimManager)
  }

  heatSimManager.on('stats', (data) => {
    if (data) {
      thermalStats.maxTemp = data.maxTemp
      thermalStats.avgTemp = data.avgTemp
      thermalStats.stepsPerSecond = data.stepsPerSecond
      thermalStats.warningCount = data.warningCount || 0
    }
  })

  heatSimManager.on('warning', (data) => {
    if (data?.warnings) {
      thermalWarnings.value = data.warnings.map(w => ({
        thyristorId: w.thyristorId,
        temperature: w.temperature.toFixed(1),
        level: w.level,
        levelName: ['正常', '注意', '警告', '危险', '熔毁'][w.level] || '未知'
      }))
    }
  })
}

const toggleThermalVisualization = () => {
  thermalEnabled.value = !thermalEnabled.value
  if (sceneManager) {
    sceneManager.setThermalVisualization(thermalEnabled.value)
  }
}

const startHeatSimulation = () => {
  if (!heatSimManager) return
  heatSimRunning.value = true
  heatSimManager.start()
}

const stopHeatSimulation = () => {
  heatSimRunning.value = false
  if (heatSimManager) {
    heatSimManager.stop()
  }
}

const injectGlobalHeat = (factor) => {
  if (heatSimManager) {
    heatSimManager.injectGlobalHeat(factor)
  }
}

const simulateCoolantBlockage = (x, y, z) => {
  if (heatSimManager) {
    heatSimManager.blockCoolant(x || 0, y || 5, z || 2)
  }
}

const restoreCoolant = (x, y, z) => {
  if (heatSimManager) {
    heatSimManager.unblockCoolant(x || 0, y || 5, z || 2)
  }
}
</script>

<style scoped>
.app-container {
  width: 100%;
  height: 100%;
  position: relative;
  overflow: hidden;
}

.scene-container {
  width: 100%;
  height: 100%;
  position: absolute;
  top: 0;
  left: 0;
}

.loading-overlay {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: rgba(10, 10, 18, 0.9);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  backdrop-filter: blur(8px);
}

.loading-content {
  text-align: center;
  color: #e0e6ed;
}

.loading-spinner {
  width: 60px;
  height: 60px;
  border: 3px solid rgba(0, 200, 255, 0.2);
  border-top-color: #00c8ff;
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin: 0 auto 20px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.loading-text {
  font-size: 18px;
  margin-bottom: 10px;
  color: #e0e6ed;
}

.loading-progress {
  font-size: 24px;
  font-weight: bold;
  color: #00c8ff;
}

.zero-copy-badge {
  position: absolute;
  top: 20px;
  left: 50%;
  transform: translateX(-50%);
  padding: 8px 20px;
  background: linear-gradient(135deg, rgba(0, 255, 136, 0.2), rgba(0, 200, 255, 0.15));
  border: 1px solid rgba(0, 255, 136, 0.4);
  border-radius: 20px;
  color: #00ff88;
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 8px;
  z-index: 50;
  backdrop-filter: blur(8px);
  box-shadow: 0 4px 16px rgba(0, 255, 136, 0.15);
  animation: badgeGlow 2s ease-in-out infinite;
}

.badge-icon {
  font-size: 16px;
}

@keyframes badgeGlow {
  0%, 100% { box-shadow: 0 4px 16px rgba(0, 255, 136, 0.15); }
  50% { box-shadow: 0 4px 24px rgba(0, 255, 136, 0.35); }
}

.thermal-control-panel {
  position: absolute;
  bottom: 60px;
  right: 20px;
  width: 320px;
  background: rgba(15, 23, 42, 0.92);
  backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 107, 53, 0.3);
  border-radius: 12px;
  overflow: hidden;
  z-index: 100;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

.thermal-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: linear-gradient(135deg, rgba(255, 107, 53, 0.15), rgba(255, 60, 60, 0.08));
  border-bottom: 1px solid rgba(255, 107, 53, 0.2);
  color: #ff6b35;
  font-size: 14px;
  font-weight: 600;
}

.thermal-stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  padding: 12px 16px;
}

.thermal-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  background: rgba(0, 0, 0, 0.2);
  border-radius: 6px;
}

.thermal-label {
  font-size: 10px;
  color: #64748b;
  text-transform: uppercase;
}

.thermal-value {
  font-size: 16px;
  font-weight: 700;
  color: #e0e6ed;
  font-family: 'Consolas', monospace;
}

.text-normal { color: #22c55e; }
.text-warning { color: #f59e0b; }
.text-critical { color: #ef4444; animation: criticalPulse 0.5s ease-in-out infinite; }
.text-meltdown { color: #ff0000; animation: meltdownPulse 0.3s ease-in-out infinite; text-shadow: 0 0 10px #ff0000; }
.text-danger { color: #ef4444; }

@keyframes criticalPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

@keyframes meltdownPulse {
  0%, 100% { opacity: 1; text-shadow: 0 0 10px #ff0000; }
  50% { opacity: 0.7; text-shadow: 0 0 20px #ff4444, 0 0 40px #ff0000; }
}

.thermal-controls {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 16px;
}

.btn-thermal {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.3);
  color: #94a3b8;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
  text-align: left;
  font-family: inherit;
}

.btn-thermal:hover {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.2);
}

.btn-thermal.active {
  border-color: rgba(0, 255, 136, 0.4);
  color: #00ff88;
  background: rgba(0, 255, 136, 0.08);
}

.btn-thermal.btn-heat {
  border-color: rgba(255, 107, 53, 0.3);
  color: #ff6b35;
}

.btn-thermal.btn-heat:hover {
  background: rgba(255, 107, 53, 0.15);
  border-color: rgba(255, 107, 53, 0.5);
}

.btn-thermal.btn-block {
  border-color: rgba(56, 189, 248, 0.3);
  color: #38bdf8;
}

.btn-thermal.btn-block:hover {
  background: rgba(56, 189, 248, 0.15);
}

.btn-thermal.btn-restore {
  border-color: rgba(34, 197, 94, 0.3);
  color: #22c55e;
}

.btn-thermal.btn-restore:hover {
  background: rgba(34, 197, 94, 0.15);
}

.thermal-legend {
  padding: 10px 16px 14px;
}

.legend-bar {
  height: 12px;
  border-radius: 6px;
  background: linear-gradient(to right,
    #0d0d26,
    #0d1a66,
    #0d4d99,
    #009966,
    #33cc1a,
    #b3d900,
    #ffb300,
    #ff5900,
    #ff1a0d,
    #fff2e6
  );
}

.legend-labels {
  display: flex;
  justify-content: space-between;
  margin-top: 4px;
  font-size: 10px;
  color: #64748b;
  font-family: 'Consolas', monospace;
}
</style>
