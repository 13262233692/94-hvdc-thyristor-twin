import { WORKER_MESSAGE_TYPE, IEC61850_CONFIG } from '../core/constants.js'

let ws = null
let isConnected = false
let reconnectAttempts = 0
let reconnectTimer = null
let config = {
  wsUrl: IEC61850_CONFIG.DEFAULT_WS_URL,
  thyristorCount: IEC61850_CONFIG.THYRISTOR_COUNT,
  simulateMode: false
}

let pulseStateCache = new Uint8Array(config.thyristorCount)
let lastPulseTime = new Float64Array(config.thyristorCount)
let svPacketCount = 0
let lastStatsTime = performance.now()
let bytesReceived = 0

const MSG = WORKER_MESSAGE_TYPE

function post(type, data) {
  self.postMessage({ type, data, timestamp: performance.now() })
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return
  }

  try {
    ws = new WebSocket(config.wsUrl)
    ws.binaryType = 'arraybuffer'

    ws.onopen = () => {
      isConnected = true
      reconnectAttempts = 0
      post(MSG.STATUS, { 
        connected: true, 
        wsUrl: config.wsUrl,
        message: 'IEC 61850 SV 流连接成功'
      })
    }

    ws.onmessage = (event) => {
      bytesReceived += event.data.byteLength
      svPacketCount++
      
      const result = parseIEC61850SV(event.data)
      if (result && result.pulseEvents.length > 0) {
        post(MSG.PULSE_EVENT, {
          events: result.pulseEvents,
          svId: result.svId,
          packetId: svPacketCount,
          timestamp: performance.now()
        })
      }

      const now = performance.now()
      if (now - lastStatsTime > 1000) {
        const rate = svPacketCount / ((now - lastStatsTime) / 1000)
        post(MSG.SV_DATA, {
          packetCount: svPacketCount,
          packetRate: rate.toFixed(1),
          bytesReceived,
          bandwidth: (bytesReceived * 8 / 1000000 / ((now - lastStatsTime) / 1000)).toFixed(2)
        })
        svPacketCount = 0
        bytesReceived = 0
        lastStatsTime = now
      }
    }

    ws.onerror = (error) => {
      post(MSG.ERROR, {
        message: 'WebSocket 错误',
        error: error.message
      })
    }

    ws.onclose = () => {
      isConnected = false
      post(MSG.STATUS, {
        connected: false,
        message: '连接断开，尝试重连...'
      })
      
      if (reconnectAttempts < IEC61850_CONFIG.MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++
        reconnectTimer = setTimeout(connect, IEC61850_CONFIG.RECONNECT_INTERVAL)
      } else {
        post(MSG.ERROR, {
          message: `已达到最大重连次数 (${IEC61850_CONFIG.MAX_RECONNECT_ATTEMPTS})，停止重连`
        })
      }
    }

  } catch (error) {
    post(MSG.ERROR, {
      message: '连接失败',
      error: error.message
    })
  }
}

function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  
  if (ws) {
    ws.close()
    ws = null
  }
  
  isConnected = false
  reconnectAttempts = 0
}

function parseIEC61850SV(buffer) {
  try {
    const view = new DataView(buffer)
    let offset = 0

    if (buffer.byteLength < IEC61850_CONFIG.SV_ID_LENGTH + 4) {
      return null
    }

    const svId = readUTF8String(view, offset, IEC61850_CONFIG.SV_ID_LENGTH)
    offset += IEC61850_CONFIG.SV_ID_LENGTH

    const sampleCount = view.getUint32(offset, false)
    offset += 4

    const thyristorCount = Math.min(sampleCount, config.thyristorCount)
    const pulseEvents = []
    const now = performance.now()

    for (let i = 0; i < thyristorCount; i++) {
      const pulseLevel = view.getUint8(offset + i)
      const previousState = pulseStateCache[i]

      if (pulseLevel > 0 && previousState === 0) {
        pulseEvents.push({
          thyristorId: i,
          level: pulseLevel,
          timestamp: now,
          duration: now - lastPulseTime[i]
        })
        lastPulseTime[i] = now
      }

      pulseStateCache[i] = pulseLevel
    }

    return {
      svId,
      sampleCount,
      pulseEvents
    }

  } catch (error) {
    console.error('SV 报文解析失败:', error)
    return null
  }
}

function readUTF8String(view, offset, length) {
  let str = ''
  for (let i = 0; i < length; i++) {
    const code = view.getUint8(offset + i)
    if (code === 0) break
    str += String.fromCharCode(code)
  }
  return str
}

function startSimulation() {
  config.simulateMode = true
  isConnected = true
  
  post(MSG.STATUS, {
    connected: true,
    wsUrl: 'simulation://local',
    message: '模拟模式已启动'
  })

  let packetId = 0
  
  const sendSimulatedPacket = () => {
    if (!config.simulateMode) return

    packetId++
    const pulseEvents = generateSimulatedPulses()
    
    if (pulseEvents.length > 0) {
      post(MSG.PULSE_EVENT, {
        events: pulseEvents,
        svId: 'SIM_SV_001',
        packetId,
        timestamp: performance.now()
      })
    }

    if (packetId % 50 === 0) {
      post(MSG.SV_DATA, {
        packetCount: 50,
        packetRate: '50.0',
        bytesReceived: 50 * 2100,
        bandwidth: '8.40'
      })
    }

    setTimeout(sendSimulatedPacket, 20)
  }

  sendSimulatedPacket()
}

function generateSimulatedPulses() {
  const events = []
  const pulseCount = Math.floor(Math.random() * 6) + 1
  const now = performance.now()

  for (let i = 0; i < pulseCount; i++) {
    const thyristorId = Math.floor(Math.random() * config.thyristorCount)
    events.push({
      thyristorId,
      level: 255,
      timestamp: now,
      duration: Math.random() * 2 + 0.5
    })
  }

  return events
}

self.onmessage = (event) => {
  const { type, data } = event.data

  switch (type) {
    case MSG.INIT:
      if (data) {
        config = { ...config, ...data }
        pulseStateCache = new Uint8Array(config.thyristorCount)
        lastPulseTime = new Float64Array(config.thyristorCount)
      }
      post(MSG.STATUS, { 
        initialized: true,
        config: { ...config }
      })
      break

    case MSG.CONNECT:
      if (data && data.simulate) {
        startSimulation()
      } else {
        if (data && data.wsUrl) {
          config.wsUrl = data.wsUrl
        }
        connect()
      }
      break

    case MSG.DISCONNECT:
      config.simulateMode = false
      disconnect()
      post(MSG.STATUS, {
        connected: false,
        message: '已手动断开连接'
      })
      break

    default:
      console.warn('未知的消息类型:', type)
  }
}
