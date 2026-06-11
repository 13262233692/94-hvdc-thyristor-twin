import { WORKER_MESSAGE_TYPE, IEC61850_CONFIG } from './constants.js'
import SVStreamWorker from '../workers/svStream.worker.js?worker'

const MSG = WORKER_MESSAGE_TYPE

export class SVStreamManager {
  constructor(options = {}) {
    this.worker = null
    this.isConnected = false
    this.isInitialized = false
    this.totalPulses = 0
    this.pulseRate = 0
    this.lastPulseTime = 0
    this.pulseCountWindow = []
    
    this.pendingEvents = []
    this.eventBuffer = new Set()
    this.maxBufferSize = options.maxBufferSize || 100
    
    this.listeners = {
      pulse: [],
      status: [],
      error: [],
      svData: []
    }

    this.thyristorCount = options.thyristorCount || IEC61850_CONFIG.THYRISTOR_COUNT
    this.instanceIdMap = options.instanceIdMap || null
  }

  init(config = {}) {
    return new Promise((resolve, reject) => {
      try {
        this.worker = new SVStreamWorker()
        
        this.worker.onmessage = (event) => {
          this.handleMessage(event.data)
        }

        this.worker.onerror = (error) => {
          console.error('Worker 错误:', error)
          this.emit('error', error)
        }

        this.send(MSG.INIT, {
          thyristorCount: this.thyristorCount,
          wsUrl: config.wsUrl || IEC61850_CONFIG.DEFAULT_WS_URL,
          ...config
        })

        const initHandler = (data) => {
          if (data.initialized) {
            this.isInitialized = true
            this.off('status', initHandler)
            resolve(this)
          }
        }
        this.on('status', initHandler)

        setTimeout(() => {
          if (!this.isInitialized) {
            reject(new Error('Worker 初始化超时'))
          }
        }, 5000)

      } catch (error) {
        reject(error)
      }
    })
  }

  connect(options = {}) {
    if (!this.worker) {
      return Promise.reject(new Error('Worker 未初始化，请先调用 init()'))
    }
    this.send(MSG.CONNECT, options)
    return Promise.resolve()
  }

  disconnect() {
    if (this.worker) {
      this.send(MSG.DISCONNECT)
    }
    this.isConnected = false
    this.pendingEvents.length = 0
    this.eventBuffer.clear()
  }

  send(type, data) {
    if (this.worker) {
      this.worker.postMessage({ type, data })
    }
  }

  handleMessage(message) {
    const { type, data } = message

    switch (type) {
      case MSG.STATUS:
        if (data.connected !== undefined) {
          this.isConnected = data.connected
        }
        this.emit('status', data)
        break

      case MSG.PULSE_EVENT:
        this.handlePulseEvent(data)
        break

      case MSG.SV_DATA:
        this.pulseRate = parseFloat(data.packetRate) || 0
        this.emit('svData', data)
        break

      case MSG.ERROR:
        this.emit('error', data)
        break

      default:
        console.warn('未知的消息类型:', type)
    }
  }

  handlePulseEvent(data) {
    const { events, timestamp } = data

    if (!events || events.length === 0) return

    const now = performance.now()
    this.lastPulseTime = now
    this.totalPulses += events.length

    this.pulseCountWindow.push({ time: now, count: events.length })
    while (this.pulseCountWindow.length > 0 && now - this.pulseCountWindow[0].time > 1000) {
      this.pulseCountWindow.shift()
    }

    for (const event of events) {
      const { thyristorId, level } = event

      if (this.instanceIdMap) {
        const mapping = this.instanceIdMap.get(thyristorId)
        if (mapping) {
          const bufferKey = `${mapping.meshIndex}_${mapping.localIndex}`
          this.eventBuffer.add(bufferKey)
          
          if (this.eventBuffer.size > this.maxBufferSize) {
            const firstKey = this.eventBuffer.values().next().value
            this.eventBuffer.delete(firstKey)
          }

          this.pendingEvents.push({
            ...event,
            ...mapping,
            level
          })
        }
      } else {
        this.pendingEvents.push({
          ...event,
          meshIndex: 0,
          localIndex: thyristorId,
          level
        })
      }
    }

    this.emit('pulse', {
      events: [...this.pendingEvents],
      buffer: this.eventBuffer,
      timestamp
    })

    this.pendingEvents.length = 0
  }

  drainEvents() {
    const events = [...this.pendingEvents]
    this.pendingEvents.length = 0
    return events
  }

  getEventBuffer() {
    return this.eventBuffer
  }

  clearBuffer() {
    this.eventBuffer.clear()
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
      this.listeners[event].forEach(cb => {
        try {
          cb(data)
        } catch (error) {
          console.error(`事件监听器错误 [${event}]:`, error)
        }
      })
    }
  }

  getStats() {
    const now = performance.now()
    const windowPulses = this.pulseCountWindow.reduce((sum, p) => sum + p.count, 0)
    const windowDuration = this.pulseCountWindow.length > 0 
      ? (now - this.pulseCountWindow[0].time) / 1000 
      : 0

    return {
      connected: this.isConnected,
      initialized: this.isInitialized,
      totalPulses: this.totalPulses,
      pulseRatePerSecond: windowDuration > 0 ? windowPulses / windowDuration : 0,
      lastPulseTime: this.lastPulseTime,
      bufferSize: this.eventBuffer.size,
      pendingCount: this.pendingEvents.length
    }
  }

  dispose() {
    this.disconnect()
    if (this.worker) {
      this.worker.terminate()
      this.worker = null
    }
    this.isInitialized = false
    this.isConnected = false
    this.pendingEvents.length = 0
    this.eventBuffer.clear()

    Object.keys(this.listeners).forEach(key => {
      this.listeners[key].length = 0
    })
  }
}

export default SVStreamManager
