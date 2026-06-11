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
import { IEC61850_CONFIG } from './core/constants.js'
import ControlPanel from './components/ControlPanel.vue'
import StatusBar from './components/StatusBar.vue'
import PulseEventFeed from './components/PulseEventFeed.vue'

const sceneContainer = ref(null)

let sceneManager = null
let svStreamManager = null

const modelLoading = ref(false)
const loadingProgress = ref(0)
const svConnected = ref(false)
const zeroCopyMode = ref(false)
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

  sceneManager.onModelLoad = (info) => {
    if (info && info.stats) {
      Object.assign(modelStats, info.stats)
    }
    
    if (!svStreamManager) {
      initSVStream()
    } else {
      svStreamManager.instanceIdMap = sceneManager.getInstanceIdMap()
    }
  }

  sceneManager.start()

  handleLoadDemo()
})

onUnmounted(() => {
  if (svStreamManager) {
    svStreamManager.dispose()
    svStreamManager = null
  }
  
  if (sceneManager) {
    sceneManager.dispose()
    sceneManager = null
  }
})
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
</style>
