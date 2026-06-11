import { HEAT_CONFIG, HEAT_MESSAGE_TYPE, WARNING_LEVEL } from './HeatConstants.js'
import { updateThyristorsFromThermalField } from './ThermalColormap.js'
import HeatSolverWorker from '../workers/heatSolver.worker.js?worker'

const MSG = HEAT_MESSAGE_TYPE

export class HeatSimManager {
  constructor(options = {}) {
    this.worker = null
    this.isInitialized = false
    this.isRunning = false

    this.thyristorCount = options.thyristorCount || 0
    this.gridDimensions = ''

    this.tempFieldSAB = null
    this.tempFieldF32 = null
    this.thyristorTempSAB = null
    this.thyristorTempF32 = null

    this.thermalVisualizationEnabled = false
    this.maxDisplayTemp = HEAT_CONFIG.MAX_TEMP

    this.warnings = []
    this.maxTemp = HEAT_CONFIG.AMBIENT_TEMP
    this.avgTemp = HEAT_CONFIG.AMBIENT_TEMP
    this.stepsPerSecond = 0

    this.listeners = {
      warning: [],
      stats: [],
      init: []
    }
  }

  async init(thyristorCount = 0) {
    this.thyristorCount = thyristorCount || HEAT_CONFIG.GRID_X * HEAT_CONFIG.GRID_Z

    const gridTotalCells = HEAT_CONFIG.GRID_X * HEAT_CONFIG.GRID_Y * HEAT_CONFIG.GRID_Z
    this.tempFieldSAB = new SharedArrayBuffer(gridTotalCells * 4)
    this.tempFieldF32 = new Float32Array(this.tempFieldSAB)

    this.thyristorTempSAB = new SharedArrayBuffer(this.thyristorCount * 4)
    this.thyristorTempF32 = new Float32Array(this.thyristorTempSAB)

    for (let i = 0; i < this.thyristorTempF32.length; i++) {
      this.thyristorTempF32[i] = HEAT_CONFIG.AMBIENT_TEMP
    }

    this.worker = new HeatSolverWorker()

    this.worker.onmessage = (event) => {
      this._handleMessage(event.data)
    }

    this.worker.onerror = (error) => {
      console.error('HeatSim Worker 错误:', error)
    }

    this._send(MSG.INIT, {
      gridX: HEAT_CONFIG.GRID_X,
      gridY: HEAT_CONFIG.GRID_Y,
      gridZ: HEAT_CONFIG.GRID_Z,
      ambientTemp: HEAT_CONFIG.AMBIENT_TEMP,
      tempFieldSAB: this.tempFieldSAB,
      thyristorTempSAB: this.thyristorTempSAB,
      thyristorCount: this.thyristorCount,
      coolantFlowRate: HEAT_CONFIG.COOLANT_FLOW_RATE,
      simulationSpeed: 1.0
    })

    return new Promise((resolve) => {
      const handler = (data) => {
        if (data.initialized) {
          this.isInitialized = true
          this.gridDimensions = data.gridDimensions
          this.off('init', handler)
          resolve(this)
        }
      }
      this.on('init', handler)

      setTimeout(() => {
        if (!this.isInitialized) resolve(this)
      }, 3000)
    })
  }

  start() {
    if (!this.isInitialized || this.isRunning) return
    this.isRunning = true
    this._send(MSG.STEP)
  }

  stop() {
    this.isRunning = false
  }

  injectPulseHeat(events) {
    if (!this.isInitialized || !events || events.length === 0) return
    this._send(MSG.INJECT_HEAT, { events })
  }

  injectGlobalHeat(factor = 1.0) {
    if (!this.isInitialized) return
    this._send(MSG.INJECT_HEAT, { globalHeat: factor })
  }

  injectThyristorHeat(thyristorId, powerFactor = 1.0) {
    if (!this.isInitialized) return
    this._send(MSG.INJECT_HEAT, { thyristorId, powerFactor })
  }

  blockCoolant(x, y, z) {
    if (!this.isInitialized) return
    this._send(MSG.INJECT_HEAT, { blockCoolant: { x, y, z } })
  }

  unblockCoolant(x, y, z) {
    if (!this.isInitialized) return
    this._send(MSG.INJECT_HEAT, { unblockCoolant: { x, y, z } })
  }

  setCoolantFlowRate(rate) {
    if (!this.isInitialized) return
    this._send(MSG.SET_COOLANT_FLOW, { rate })
  }

  setSimulationSpeed(speed) {
    if (!this.isInitialized) return
    this._send(MSG.SET_SIMULATION_SPEED, { speed })
  }

  applyThermalVisualization(meshData) {
    if (!this.thermalVisualizationEnabled || !this.thyristorTempF32) return
    updateThyristorsFromThermalField(
      meshData,
      this.thyristorTempF32,
      this.thyristorCount,
      HEAT_CONFIG.AMBIENT_TEMP,
      this.maxDisplayTemp
    )
  }

  enableThermalVisualization(enabled) {
    this.thermalVisualizationEnabled = enabled
  }

  getTemperatureAt(x, y, z) {
    if (this.tempFieldF32) {
      const nx = HEAT_CONFIG.GRID_X
      const ny = HEAT_CONFIG.GRID_Y
      if (x >= 0 && x < nx && y >= 0 && y < ny && z >= 0 && z < HEAT_CONFIG.GRID_Z) {
        const idx = x + y * nx + z * nx * ny
        return this.tempFieldF32[idx]
      }
    }
    return HEAT_CONFIG.AMBIENT_TEMP
  }

  getThyristorTemperature(id) {
    if (this.thyristorTempF32 && id < this.thyristorTempF32.length) {
      return this.thyristorTempF32[id]
    }
    return HEAT_CONFIG.AMBIENT_TEMP
  }

  getWarnings() {
    return this.warnings
  }

  getStats() {
    return {
      running: this.isRunning,
      maxTemp: this.maxTemp,
      avgTemp: this.avgTemp,
      warnings: this.warnings.length,
      stepsPerSecond: this.stepsPerSecond,
      thermalVisualization: this.thermalVisualizationEnabled
    }
  }

  _send(type, data) {
    if (this.worker) {
      this.worker.postMessage({ type, data })
    }
  }

  _handleMessage(message) {
    const { type, data } = message

    switch (type) {
      case MSG.INIT:
        this.emit('init', data)
        break

      case MSG.STATS:
        if (data) {
          this.maxTemp = data.maxTemp || this.maxTemp
          this.avgTemp = data.avgTemp || this.avgTemp
          this.stepsPerSecond = data.stepsPerSecond || 0
        }
        this.emit('stats', data)
        break

      case MSG.WARNING:
        if (data?.warnings) {
          this.warnings = data.warnings
        }
        this.emit('warning', data)
        break

      default:
        break
    }
  }

  on(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event].push(callback)
    }
    return this
  }

  off(event, callback) {
    if (this.listeners[event]) {
      const idx = this.listeners[event].indexOf(callback)
      if (idx > -1) this.listeners[event].splice(idx, 1)
    }
    return this
  }

  emit(event, data) {
    if (this.listeners[event]) {
      for (const cb of this.listeners[event]) {
        try { cb(data) } catch (e) { console.error(e) }
      }
    }
  }

  dispose() {
    this.stop()
    if (this.worker) {
      this._send(MSG.DISPOSE)
      this.worker.terminate()
      this.worker = null
    }
    this.isInitialized = false
    this.tempFieldSAB = null
    this.tempFieldF32 = null
    this.thyristorTempSAB = null
    this.thyristorTempF32 = null
    this.warnings = []
    Object.keys(this.listeners).forEach(k => { this.listeners[k].length = 0 })
  }
}

export default HeatSimManager
