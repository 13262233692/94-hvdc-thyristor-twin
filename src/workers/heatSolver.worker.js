import { HeatSolver3D } from '../core/HeatSolver3D.js'
import { HEAT_CONFIG, HEAT_MESSAGE_TYPE, WARNING_LEVEL } from '../core/HeatConstants.js'

const MSG = HEAT_MESSAGE_TYPE

let solver = null
let running = false
let animationId = null

let tempOutputSAB = null
let tempOutputF32 = null
let thyristorTempSAB = null
let thyristorTempF32 = null
let thyristorCount = 0

let lastStatsTime = 0
let stepsSinceLastStats = 0
let lastPulseEvents = []

function post(type, data) {
  self.postMessage({ type, data, timestamp: performance.now() })
}

function initFromConfig(data) {
  solver = new HeatSolver3D({
    gridX: data?.gridX || HEAT_CONFIG.GRID_X,
    gridY: data?.gridY || HEAT_CONFIG.GRID_Y,
    gridZ: data?.gridZ || HEAT_CONFIG.GRID_Z,
    ambientTemp: data?.ambientTemp || HEAT_CONFIG.AMBIENT_TEMP
  })

  thyristorCount = solver.thyristorCells.size

  if (data?.tempFieldSAB) {
    tempOutputSAB = data.tempFieldSAB
    tempOutputF32 = new Float32Array(tempOutputSAB)
  }

  if (data?.thyristorTempSAB) {
    thyristorTempSAB = data.thyristorTempSAB
    thyristorTempF32 = new Float32Array(thyristorTempSAB)
  }

  if (data?.coolantFlowRate !== undefined) {
    solver.coolantFlowRate = data.coolantFlowRate
  }
  if (data?.simulationSpeed !== undefined) {
    solver.simulationSpeed = data.simulationSpeed
  }
}

function simulationLoop() {
  if (!running || !solver) return

  const dt = HEAT_CONFIG.DT
  const steps = HEAT_CONFIG.STEPS_PER_FRAME

  for (let i = 0; i < steps; i++) {
    injectHeatFromPulses()
    solver.step(dt)
  }

  outputTemperatureField()
  outputThyristorTemperatures()

  stepsSinceLastStats += steps

  const now = performance.now()
  if (now - lastStatsTime > 500) {
    const warnings = solver.getWarnings()
    const stats = solver.getStats()
    stats.stepsPerSecond = Math.round(stepsSinceLastStats / ((now - lastStatsTime) / 1000))
    
    post(MSG.STATS, stats)

    if (warnings.length > 0) {
      post(MSG.WARNING, { warnings, maxTemp: solver.maxTemp })
    }

    stepsSinceLastStats = 0
    lastStatsTime = now
  }

  animationId = setTimeout(simulationLoop, 16)
}

function injectHeatFromPulses() {
  for (const evt of lastPulseEvents) {
    solver.injectThyristorHeat(evt.thyristorId, evt.powerFactor || 1.0)
  }
  lastPulseEvents = []
}

function outputTemperatureField() {
  if (!tempOutputF32) return

  const field = solver.getTemperatureField()
  const len = Math.min(field.length, tempOutputF32.length)
  for (let i = 0; i < len; i++) {
    tempOutputF32[i] = field[i]
  }
}

function outputThyristorTemperatures() {
  if (!thyristorTempF32) return

  const temps = solver.getThyristorTemperatures()
  const len = Math.min(temps.length, thyristorTempF32.length)
  for (let i = 0; i < len; i++) {
    thyristorTempF32[i] = temps[i]
  }
}

function handlePulseEvents(events) {
  for (const evt of events) {
    lastPulseEvents.push({
      thyristorId: evt.thyristorId % thyristorCount,
      powerFactor: (evt.level || 255) / 255
    })
  }
}

function injectContinuousHeat(thyristorId, powerFactor) {
  if (!solver) return
  solver.injectThyristorHeat(thyristorId % thyristorCount, powerFactor)
}

function setCoolantBlockage(x, y, z, blocked) {
  if (!solver) return
  solver.setCoolantBlockage(x, y, z, blocked)
}

self.onmessage = (event) => {
  const { type, data } = event.data

  switch (type) {
    case MSG.INIT:
      initFromConfig(data)
      post(MSG.INIT, {
        initialized: true,
        thyristorCount,
        gridDimensions: `${solver.nx}×${solver.ny}×${solver.nz}`,
        totalCells: solver.totalCells
      })
      break

    case MSG.STEP:
      if (!running && solver) {
        running = true
        lastStatsTime = performance.now()
        simulationLoop()
      }
      break

    case MSG.INJECT_HEAT:
      if (data) {
        if (data.events) {
          handlePulseEvents(data.events)
        }
        if (data.thyristorId !== undefined) {
          injectContinuousHeat(data.thyristorId, data.powerFactor)
        }
        if (data.globalHeat !== undefined) {
          const factor = data.globalHeat
          for (const [id] of solver.thyristorCells) {
            solver.injectThyristorHeat(id, factor)
          }
        }
        if (data.blockCoolant) {
          const { x, y, z } = data.blockCoolant
          setCoolantBlockage(x, y, z, true)
        }
        if (data.unblockCoolant) {
          const { x, y, z } = data.unblockCoolant
          setCoolantBlockage(x, y, z, false)
        }
      }
      break

    case MSG.SET_COOLANT_FLOW:
      if (solver && data?.rate !== undefined) {
        solver.coolantFlowRate = data.rate
      }
      break

    case MSG.SET_SIMULATION_SPEED:
      if (solver && data?.speed !== undefined) {
        solver.simulationSpeed = data.speed
      }
      break

    case MSG.GET_TEMPERATURE:
      if (solver && data) {
        const temp = solver.getTemperatureAt(data.x, data.y, data.z)
        post(MSG.GET_TEMPERATURE, { x: data.x, y: data.y, z: data.z, temperature: temp })
      }
      break

    case MSG.DISPOSE:
      running = false
      if (animationId) {
        clearTimeout(animationId)
        animationId = null
      }
      if (solver) {
        solver.dispose()
        solver = null
      }
      break

    default:
      break
  }
}
