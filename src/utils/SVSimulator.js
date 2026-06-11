import { IEC61850_CONFIG } from '../core/constants.js'

export class SVSimulator {
  constructor(options = {}) {
    this.thyristorCount = options.thyristorCount || IEC61850_CONFIG.THYRISTOR_COUNT
    this.sampleRate = options.sampleRate || 50
    this.pulseProbability = options.pulseProbability || 0.02
    this.burstProbability = options.burstProbability || 0.1
    this.burstSize = options.burstSize || { min: 3, max: 15 }
    
    this.isRunning = false
    this.intervalId = null
    this.packetCount = 0
    this.listeners = {
      svData: [],
      pulseEvent: []
    }

    this.pulseState = new Uint8Array(this.thyristorCount)
    this.pulseHistory = []
  }

  start() {
    if (this.isRunning) return
    
    this.isRunning = true
    this.intervalId = setInterval(() => this.generatePacket(), 1000 / this.sampleRate)
  }

  stop() {
    this.isRunning = false
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
  }

  generatePacket() {
    this.packetCount++
    
    const newState = new Uint8Array(this.thyristorCount)
    const pulseEvents = []
    const timestamp = performance.now()

    const isBurst = Math.random() < this.burstProbability
    const pulseCount = isBurst 
      ? Math.floor(Math.random() * (this.burstSize.max - this.burstSize.min + 1)) + this.burstSize.min
      : Math.floor(Math.random() * 4) + 1

    for (let i = 0; i < pulseCount; i++) {
      if (Math.random() < this.pulseProbability) {
        const thyristorId = Math.floor(Math.random() * this.thyristorCount)
        const pulseLevel = Math.floor(Math.random() * 128) + 128
        
        newState[thyristorId] = pulseLevel
        
        if (this.pulseState[thyristorId] === 0) {
          const event = {
            thyristorId,
            level: pulseLevel,
            timestamp,
            duration: Math.random() * 3 + 0.5,
            isBurst
          }
          pulseEvents.push(event)
          
          this.pulseHistory.push({
            ...event,
            packetId: this.packetCount
          })
          
          if (this.pulseHistory.length > 1000) {
            this.pulseHistory.shift()
          }
        }
      }
    }

    this.pulseState.set(newState)

    if (pulseEvents.length > 0) {
      this.emit('pulseEvent', {
        events: pulseEvents,
        svId: `SIM_SV_${String(this.packetCount).padStart(6, '0')}`,
        packetId: this.packetCount,
        timestamp
      })
    }

    this.emit('svData', {
      packetCount: this.packetCount,
      packetRate: this.sampleRate,
      pulseEventsInPacket: pulseEvents.length,
      timestamp,
      buffer: this.encodeSVPacket(newState, pulseEvents)
    })
  }

  encodeSVPacket(pulseState, events) {
    const svId = 'SIM_SV_001'
    const headerLength = IEC61850_CONFIG.SV_ID_LENGTH + 4
    const dataLength = this.thyristorCount
    const buffer = new ArrayBuffer(headerLength + dataLength)
    const view = new DataView(buffer)

    for (let i = 0; i < IEC61850_CONFIG.SV_ID_LENGTH; i++) {
      view.setUint8(i, i < svId.length ? svId.charCodeAt(i) : 0)
    }

    view.setUint32(IEC61850_CONFIG.SV_ID_LENGTH, this.thyristorCount, false)

    for (let i = 0; i < this.thyristorCount; i++) {
      view.setUint8(headerLength + i, pulseState[i])
    }

    return buffer
  }

  static generateWaveform(thyristorId, time, frequency = 50) {
    const phaseOffset = (thyristorId % 6) * Math.PI / 3
    const phase = 2 * Math.PI * frequency * time + phaseOffset
    const firingAngle = Math.PI / 6 + (thyristorId % 3) * Math.PI / 12
    
    if (phase > firingAngle && phase < Math.PI - firingAngle) {
      return Math.floor(255 * Math.sin(phase))
    }
    return 0
  }

  generateRealisticPacket(time) {
    const newState = new Uint8Array(this.thyristorCount)
    const pulseEvents = []
    const timestamp = performance.now()

    for (let i = 0; i < this.thyristorCount; i++) {
      const level = SVSimulator.generateWaveform(i, time / 1000)
      newState[i] = level

      if (level > 0 && this.pulseState[i] === 0) {
        pulseEvents.push({
          thyristorId: i,
          level,
          timestamp,
          duration: 8.33,
          isBurst: false
        })
      }
    }

    this.pulseState.set(newState)

    return { pulseEvents, state: newState }
  }

  on(event, callback) {
    if (this.listeners[event]) {
      this.listeners[event].push(callback)
    }
    return this
  }

  off(event, callback) {
    if (this.listeners[event]) {
      const index = this.listeners[event].indexOf(callback)
      if (index > -1) {
        this.listeners[event].splice(index, 1)
      }
    }
    return this
  }

  emit(event, data) {
    if (this.listeners[event]) {
      this.listeners[event].forEach(cb => cb(data))
    }
  }

  getStats() {
    return {
      running: this.isRunning,
      packetCount: this.packetCount,
      sampleRate: this.sampleRate,
      thyristorCount: this.thyristorCount,
      activePulses: this.pulseState.filter(s => s > 0).length,
      historySize: this.pulseHistory.length
    }
  }

  reset() {
    this.pulseState.fill(0)
    this.pulseHistory.length = 0
    this.packetCount = 0
  }

  dispose() {
    this.stop()
    this.reset()
    Object.keys(this.listeners).forEach(key => {
      this.listeners[key].length = 0
    })
  }
}

export function createMockSVPacket(thyristorCount = 100, pulseCount = 5) {
  const buffer = new ArrayBuffer(IEC61850_CONFIG.SV_ID_LENGTH + 4 + thyristorCount)
  const view = new DataView(buffer)
  
  const svId = 'MOCK_SV_01'
  for (let i = 0; i < IEC61850_CONFIG.SV_ID_LENGTH; i++) {
    view.setUint8(i, i < svId.length ? svId.charCodeAt(i) : 0)
  }
  
  view.setUint32(IEC61850_CONFIG.SV_ID_LENGTH, thyristorCount, false)
  
  const offset = IEC61850_CONFIG.SV_ID_LENGTH + 4
  for (let i = 0; i < thyristorCount; i++) {
    view.setUint8(offset + i, 0)
  }
  
  for (let i = 0; i < pulseCount; i++) {
    const idx = Math.floor(Math.random() * thyristorCount)
    view.setUint8(offset + idx, Math.floor(Math.random() * 128) + 128)
  }
  
  return buffer
}

export default SVSimulator
