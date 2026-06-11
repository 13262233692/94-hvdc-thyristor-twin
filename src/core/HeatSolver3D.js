import { HEAT_CONFIG, MATERIAL_TYPE, WARNING_LEVEL } from './HeatConstants.js'

const {
  GRID_X, GRID_Y, GRID_Z,
  AMBIENT_TEMP, WARNING_TEMP, CRITICAL_TEMP, MELTDOWN_TEMP,
  DIFFUSIVITY_THYRISTOR, DIFFUSIVITY_ALUMINUM, DIFFUSIVITY_COOLANT,
  DIFFUSIVITY_INSULATOR, DIFFUSIVITY_AIR,
  CONVECTION_COEFF, COOLANT_FLOW_RATE, COOLANT_INLET_TEMP,
  I2R_HEAT_SCALE, THYRISTOR_CURRENT, THYRISTOR_RESISTANCE,
  CFL_SAFETY
} = HEAT_CONFIG

export class HeatSolver3D {
  constructor(config = {}) {
    this.nx = config.gridX || GRID_X
    this.ny = config.gridY || GRID_Y
    this.nz = config.gridZ || GRID_Z
    this.totalCells = this.nx * this.ny * this.nz

    this.ambientTemp = config.ambientTemp || AMBIENT_TEMP

    this.T = new Float32Array(this.totalCells)
    this.T_new = new Float32Array(this.totalCells)
    this.heatSource = new Float32Array(this.totalCells)
    this.materialType = new Uint8Array(this.totalCells)
    this.diffusivity = new Float32Array(this.totalCells)

    this.thyristorCells = new Map()
    this.coolantPathCells = []
    this.hotspotLog = []

    this.maxTemp = this.ambientTemp
    this.avgTemp = this.ambientTemp
    this.warningCells = []
    this.coolantFlowRate = COOLANT_FLOW_RATE
    this.simulationSpeed = 1.0

    this.stepCount = 0
    this.lastStepTime = 0

    this._initGrid()
    this._buildTopology()
  }

  _idx(x, y, z) {
    return x + y * this.nx + z * this.nx * this.ny
  }

  _initGrid() {
    for (let i = 0; i < this.totalCells; i++) {
      this.T[i] = this.ambientTemp
      this.T_new[i] = this.ambientTemp
      this.heatSource[i] = 0
      this.materialType[i] = MATERIAL_TYPE.AIR
      this.diffusivity[i] = DIFFUSIVITY_AIR
    }
  }

  _buildTopology() {
    const levels = 8
    const thyristorsPerLevel = 6
    const spacing_x = Math.max(1, Math.floor(this.nx / (thyristorsPerLevel + 1)))
    const spacing_y = Math.max(1, Math.floor(this.ny / (levels + 1)))

    for (let level = 0; level < levels; level++) {
      const z = Math.min(Math.floor(this.nz * (level + 0.5) / levels), this.nz - 1)
      const y_center = Math.min(Math.floor(this.ny * (level + 0.5) / levels), this.ny - 1)

      for (let t = 0; t < thyristorsPerLevel; t++) {
        const x = Math.min(spacing_x * (t + 1), this.nx - 1)
        const y = Math.min(y_center, this.ny - 1)

        const idx = this._idx(x, y, z)
        this.materialType[idx] = MATERIAL_TYPE.THYRISTOR
        this.diffusivity[idx] = DIFFUSIVITY_THYRISTOR

        this.thyristorCells.set(t + level * thyristorsPerLevel, { x, y, z, idx })

        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            const nx2 = x + dx
            const ny2 = y + dy
            if (nx2 < 0 || nx2 >= this.nx || ny2 < 0 || ny2 >= this.ny) continue
            if (dx === 0 && dy === 0) continue
            const neighborIdx = this._idx(nx2, ny2, z)
            if (this.materialType[neighborIdx] === MATERIAL_TYPE.AIR) {
              this.materialType[neighborIdx] = MATERIAL_TYPE.ALUMINUM_HEATSINK
              this.diffusivity[neighborIdx] = DIFFUSIVITY_ALUMINUM
            }
          }
        }

        if (z + 1 < this.nz) {
          const aboveIdx = this._idx(x, y, z + 1)
          this.materialType[aboveIdx] = MATERIAL_TYPE.INSULATOR
          this.diffusivity[aboveIdx] = DIFFUSIVITY_INSULATOR
        }
        if (z - 1 >= 0) {
          const belowIdx = this._idx(x, y, z - 1)
          this.materialType[belowIdx] = MATERIAL_TYPE.INSULATOR
          this.diffusivity[belowIdx] = DIFFUSIVITY_INSULATOR
        }
      }
    }

    for (let z = 0; z < this.nz; z++) {
      for (let y = 0; y < this.ny; y++) {
        const idx1 = this._idx(0, y, z)
        if (this.materialType[idx1] === MATERIAL_TYPE.AIR) {
          this.materialType[idx1] = MATERIAL_TYPE.COOLANT_PIPE
          this.diffusivity[idx1] = DIFFUSIVITY_COOLANT
          this.coolantPathCells.push({ x: 0, y, z, idx: idx1 })
        }

        const idx2 = this._idx(this.nx - 1, y, z)
        if (this.materialType[idx2] === MATERIAL_TYPE.AIR) {
          this.materialType[idx2] = MATERIAL_TYPE.COOLANT_PIPE
          this.diffusivity[idx2] = DIFFUSIVITY_COOLANT
          this.coolantPathCells.push({ x: this.nx - 1, y, z, idx: idx2 })
        }
      }

      for (let x = 0; x < this.nx; x++) {
        const idx3 = this._idx(x, 0, z)
        if (this.materialType[idx3] === MATERIAL_TYPE.AIR) {
          this.materialType[idx3] = MATERIAL_TYPE.FRAME
          this.diffusivity[idx3] = DIFFUSIVITY_ALUMINUM * 0.5
        }

        const idx4 = this._idx(x, this.ny - 1, z)
        if (this.materialType[idx4] === MATERIAL_TYPE.AIR) {
          this.materialType[idx4] = MATERIAL_TYPE.FRAME
          this.diffusivity[idx4] = DIFFUSIVITY_ALUMINUM * 0.5
        }
      }
    }
  }

  injectThyristorHeat(thyristorId, powerFactor = 1.0) {
    const cell = this.thyristorCells.get(thyristorId)
    if (!cell) return

    const I2R = THYRISTOR_CURRENT * THYRISTOR_CURRENT * THYRISTOR_RESISTANCE
    const heatPower = I2R * I2R_HEAT_SCALE * powerFactor

    this.heatSource[cell.idx] += heatPower

    const neighbors = this._getNeighbors6(cell.x, cell.y, cell.z)
    for (const nIdx of neighbors) {
      if (this.materialType[nIdx] === MATERIAL_TYPE.ALUMINUM_HEATSINK ||
          this.materialType[nIdx] === MATERIAL_TYPE.INSULATOR) {
        this.heatSource[nIdx] += heatPower * 0.15
      }
    }
  }

  injectHeatAt(x, y, z, power) {
    if (x < 0 || x >= this.nx || y < 0 || y >= this.ny || z < 0 || z >= this.nz) return
    const idx = this._idx(x, y, z)
    this.heatSource[idx] += power
  }

  setCoolantBlockage(x, y, z, blocked = true) {
    if (x < 0 || x >= this.nx || y < 0 || y >= this.ny || z < 0 || z >= this.nz) return
    const idx = this._idx(x, y, z)
    if (this.materialType[idx] === MATERIAL_TYPE.COOLANT_PIPE) {
      this.diffusivity[idx] = blocked ? DIFFUSIVITY_INSULATOR : DIFFUSIVITY_COOLANT
    }
  }

  step(dt) {
    const effectiveDt = dt * this.simulationSpeed
    const dx2 = 1.0 / (this.nx * this.nx)
    const dy2 = 1.0 / (this.ny * this.ny)
    const dz2 = 1.0 / (this.nz * this.nz)

    let maxT = -Infinity
    let sumT = 0

    for (let z = 0; z < this.nz; z++) {
      for (let y = 0; y < this.ny; y++) {
        for (let x = 0; x < this.nx; x++) {
          const idx = this._idx(x, y, z)
          const alpha = this.diffusivity[idx]
          const Tc = this.T[idx]

          const Txp = (x + 1 < this.nx) ? this.T[this._idx(x + 1, y, z)] : Tc
          const Txm = (x - 1 >= 0) ? this.T[this._idx(x - 1, y, z)] : Tc
          const Typ = (y + 1 < this.ny) ? this.T[this._idx(x, y + 1, z)] : Tc
          const Tym = (y - 1 >= 0) ? this.T[this._idx(x, y - 1, z)] : Tc
          const Tzp = (z + 1 < this.nz) ? this.T[this._idx(x, y, z + 1)] : Tc
          const Tzm = (z - 1 >= 0) ? this.T[this._idx(x, y, z - 1)] : Tc

          const laplacian =
            (Txp - 2 * Tc + Txm) / dx2 +
            (Typ - 2 * Tc + Tym) / dy2 +
            (Tzp - 2 * Tc + Tzm) / dz2

          let dT = alpha * laplacian * effectiveDt * CFL_SAFETY

          dT += this.heatSource[idx] * effectiveDt

          if (this.materialType[idx] === MATERIAL_TYPE.COOLANT_PIPE) {
            const cooling = this.coolantFlowRate * (Tc - COOLANT_INLET_TEMP) * effectiveDt
            dT -= cooling
          } else if (this.materialType[idx] === MATERIAL_TYPE.AIR) {
            const convLoss = CONVECTION_COEFF * (Tc - this.ambientTemp) * effectiveDt
            dT -= convLoss
          }

          let newT = Tc + dT
          if (newT < this.ambientTemp) newT = this.ambientTemp

          this.T_new[idx] = newT

          if (newT > maxT) maxT = newT
          sumT += newT

          this.heatSource[idx] = 0
        }
      }
    }

    const tmp = this.T
    this.T = this.T_new
    this.T_new = tmp

    this.maxTemp = maxT
    this.avgTemp = sumT / this.totalCells
    this.stepCount++

    this._checkWarnings()

    return {
      maxTemp: this.maxTemp,
      avgTemp: this.avgTemp,
      stepCount: this.stepCount
    }
  }

  _getNeighbors6(x, y, z) {
    const neighbors = []
    if (x + 1 < this.nx) neighbors.push(this._idx(x + 1, y, z))
    if (x - 1 >= 0) neighbors.push(this._idx(x - 1, y, z))
    if (y + 1 < this.ny) neighbors.push(this._idx(x, y + 1, z))
    if (y - 1 >= 0) neighbors.push(this._idx(x, y - 1, z))
    if (z + 1 < this.nz) neighbors.push(this._idx(x, y, z + 1))
    if (z - 1 >= 0) neighbors.push(this._idx(x, y, z - 1))
    return neighbors
  }

  _checkWarnings() {
    this.warningCells = []

    if (this.stepCount % 10 !== 0) return

    for (const [id, cell] of this.thyristorCells) {
      const temp = this.T[cell.idx]
      let level = WARNING_LEVEL.NORMAL

      if (temp >= MELTDOWN_TEMP) {
        level = WARNING_LEVEL.MELTDOWN
      } else if (temp >= CRITICAL_TEMP) {
        level = WARNING_LEVEL.CRITICAL
      } else if (temp >= WARNING_TEMP) {
        level = WARNING_LEVEL.WARNING
      } else if (temp >= WARNING_TEMP * 0.9) {
        level = WARNING_LEVEL.CAUTION
      }

      if (level > WARNING_LEVEL.NORMAL) {
        this.warningCells.push({
          thyristorId: id,
          temperature: temp,
          level,
          x: cell.x,
          y: cell.y,
          z: cell.z
        })
      }
    }

    if (this.warningCells.some(w => w.level >= WARNING_LEVEL.CRITICAL)) {
      this.hotspotLog.push({
        time: performance.now(),
        step: this.stepCount,
        warnings: [...this.warningCells],
        maxTemp: this.maxTemp
      })
      if (this.hotspotLog.length > 100) this.hotspotLog.shift()
    }
  }

  getTemperatureField() {
    return this.T
  }

  getThyristorTemperatures() {
    const temps = new Float32Array(this.thyristorCells.size)
    for (const [id, cell] of this.thyristorCells) {
      temps[id] = this.T[cell.idx]
    }
    return temps
  }

  getTemperatureAt(x, y, z) {
    if (x < 0 || x >= this.nx || y < 0 || y >= this.ny || z < 0 || z >= this.nz) {
      return this.ambientTemp
    }
    return this.T[this._idx(x, y, z)]
  }

  getWarnings() {
    return this.warningCells
  }

  getStats() {
    return {
      stepCount: this.stepCount,
      maxTemp: this.maxTemp,
      avgTemp: this.avgTemp,
      warningCount: this.warningCells.length,
      thyristorCount: this.thyristorCells.size,
      coolantCellCount: this.coolantPathCells.length,
      gridDimensions: `${this.nx}×${this.ny}×${this.nz}`,
      totalCells: this.totalCells,
      simulationSpeed: this.simulationSpeed,
      coolantFlowRate: this.coolantFlowRate
    }
  }

  reset() {
    for (let i = 0; i < this.totalCells; i++) {
      this.T[i] = this.ambientTemp
      this.T_new[i] = this.ambientTemp
      this.heatSource[i] = 0
    }
    this.maxTemp = this.ambientTemp
    this.avgTemp = this.ambientTemp
    this.warningCells = []
    this.stepCount = 0
  }

  dispose() {
    this.T = null
    this.T_new = null
    this.heatSource = null
    this.materialType = null
    this.diffusivity = null
    this.thyristorCells.clear()
    this.coolantPathCells = null
    this.hotspotLog = null
    this.warningCells = null
  }
}

export default HeatSolver3D
