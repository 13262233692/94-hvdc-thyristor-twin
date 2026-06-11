import * as THREE from 'three'
import { HEAT_CONFIG, WARNING_LEVEL } from './HeatConstants.js'

const INFRARED_STOPS = [
  { t: 0.00, r: 0.05, g: 0.05, b: 0.15 },
  { t: 0.15, r: 0.05, g: 0.10, b: 0.40 },
  { t: 0.30, r: 0.05, g: 0.30, b: 0.60 },
  { t: 0.45, r: 0.00, g: 0.60, b: 0.40 },
  { t: 0.55, r: 0.20, g: 0.80, b: 0.10 },
  { t: 0.65, r: 0.70, g: 0.85, b: 0.00 },
  { t: 0.75, r: 1.00, g: 0.70, b: 0.00 },
  { t: 0.85, r: 1.00, g: 0.35, b: 0.00 },
  { t: 0.92, r: 1.00, g: 0.10, b: 0.05 },
  { t: 1.00, r: 1.00, g: 0.95, b: 0.90 }
]

const _tempColor = { r: 0, g: 0, b: 0 }

export function temperatureToColor(temp, minTemp, maxTemp) {
  const range = maxTemp - minTemp
  const t = range > 0 ? Math.max(0, Math.min(1, (temp - minTemp) / range)) : 0

  let lower = INFRARED_STOPS[0]
  let upper = INFRARED_STOPS[INFRARED_STOPS.length - 1]

  for (let i = 0; i < INFRARED_STOPS.length - 1; i++) {
    if (t >= INFRARED_STOPS[i].t && t <= INFRARED_STOPS[i + 1].t) {
      lower = INFRARED_STOPS[i]
      upper = INFRARED_STOPS[i + 1]
      break
    }
  }

  const localT = (upper.t - lower.t) > 0 ? (t - lower.t) / (upper.t - lower.t) : 0
  _tempColor.r = lower.r + (upper.r - lower.r) * localT
  _tempColor.g = lower.g + (upper.g - lower.g) * localT
  _tempColor.b = lower.b + (upper.b - lower.b) * localT

  return _tempColor
}

export function temperatureToWarningLevel(temp) {
  if (temp >= HEAT_CONFIG.MELTDOWN_TEMP) return WARNING_LEVEL.MELTDOWN
  if (temp >= HEAT_CONFIG.CRITICAL_TEMP) return WARNING_LEVEL.CRITICAL
  if (temp >= HEAT_CONFIG.WARNING_TEMP) return WARNING_LEVEL.WARNING
  if (temp >= HEAT_CONFIG.WARNING_TEMP * 0.9) return WARNING_LEVEL.CAUTION
  return WARNING_LEVEL.NORMAL
}

export function updateThyristorsFromThermalField(meshData, thyristorTempF32, thyristorCount, ambientTemp, maxDisplayTemp) {
  const { mesh, count } = meshData
  const instanceColor = mesh.instanceColor
  if (!instanceColor) return

  const minT = ambientTemp
  const maxT = maxDisplayTemp || HEAT_CONFIG.MAX_TEMP

  for (let i = 0; i < count; i++) {
    const temp = (thyristorTempF32 && i < thyristorTempF32.length)
      ? thyristorTempF32[i]
      : minT

    const color = temperatureToColor(temp, minT, maxT)

    const pulseStateAttr = mesh.geometry.attributes.aPulseState
    const pulseIntensityAttr = mesh.geometry.attributes.aPulseIntensity

    let pulseIntensity = 0
    if (pulseIntensityAttr) {
      pulseIntensity = pulseIntensityAttr.array[i] || 0
    }

    if (pulseIntensity > 0.3) {
      instanceColor.array[i * 4] = 0.24 + pulseIntensity * 0.76
      instanceColor.array[i * 4 + 1] = 0.35 - pulseIntensity * 0.3
      instanceColor.array[i * 4 + 2] = 0.42 - pulseIntensity * 0.4
      instanceColor.array[i * 4 + 3] = 1.0
    } else {
      const thermalBlend = Math.max(0, Math.min(1, (temp - minT) / (maxT - minT)))
      const blendFactor = thermalBlend * HEAT_CONFIG.EMISSIVE_BOOST

      const baseR = 0.24
      const baseG = 0.35
      const baseB = 0.42

      instanceColor.array[i * 4] = baseR + (color.r - baseR) * blendFactor
      instanceColor.array[i * 4 + 1] = baseG + (color.g - baseG) * blendFactor
      instanceColor.array[i * 4 + 2] = baseB + (color.b - baseB) * blendFactor
      instanceColor.array[i * 4 + 3] = 1.0
    }
  }

  instanceColor.needsUpdate = true
}

export function createThermalOverlayMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: `
      varying vec3 vWorldPosition;
      varying vec3 vNormal;
      
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vec4 worldPos = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPos.xyz;
        gl_Position = projectionMatrix * viewMatrix * worldPos;
      }
    `,
    fragmentShader: `
      uniform sampler2D uThermalMap;
      uniform float uOpacity;
      uniform float uTemperatureMin;
      uniform float uTemperatureMax;
      uniform vec3 uBoundsMin;
      uniform vec3 uBoundsMax;
      
      varying vec3 vWorldPosition;
      varying vec3 vNormal;
      
      void main() {
        vec3 uvw = (vWorldPosition - uBoundsMin) / (uBoundsMax - uBoundsMin);
        
        if (uvw.x < 0.0 || uvw.x > 1.0 || 
            uvw.y < 0.0 || uvw.y > 1.0 || 
            uvw.z < 0.0 || uvw.z > 1.0) {
          discard;
        }
        
        float u = uvw.x;
        float v = uvw.y;
        
        vec4 thermalColor = texture2D(uThermalMap, vec2(u, v));
        
        float temp = mix(uTemperatureMin, uTemperatureMax, thermalColor.r);
        
        float threshold = uTemperatureMin + (uTemperatureMax - uTemperatureMin) * 0.1;
        float alpha = smoothstep(threshold, threshold + 5.0, temp) * uOpacity;
        
        gl_FragColor = vec4(thermalColor.rgb, alpha);
      }
    `,
    uniforms: {
      uThermalMap: { value: null },
      uOpacity: { value: 0.6 },
      uTemperatureMin: { value: HEAT_CONFIG.AMBIENT_TEMP },
      uTemperatureMax: { value: HEAT_CONFIG.MAX_TEMP },
      uBoundsMin: { value: new THREE.Vector3(-10, 0, -5) },
      uBoundsMax: { value: new THREE.Vector3(10, 30, 5) }
    },
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide
  })
}

export function createThermalColorLegend() {
  const canvas = document.createElement('canvas')
  canvas.width = HEAT_CONFIG.THERMAL_MAP_RESOLUTION
  canvas.height = 20
  const ctx = canvas.getContext('2d')

  for (let x = 0; x < canvas.width; x++) {
    const t = x / canvas.width
    const color = temperatureToColor(
      HEAT_CONFIG.AMBIENT_TEMP + t * (HEAT_CONFIG.MAX_TEMP - HEAT_CONFIG.AMBIENT_TEMP),
      HEAT_CONFIG.AMBIENT_TEMP,
      HEAT_CONFIG.MAX_TEMP
    )
    ctx.fillStyle = `rgb(${Math.round(color.r * 255)},${Math.round(color.g * 255)},${Math.round(color.b * 255)})`
    ctx.fillRect(x, 0, 1, 20)
  }

  return canvas
}

export { INFRARED_STOPS }
export default {
  temperatureToColor,
  temperatureToWarningLevel,
  updateThyristorsFromThermalField,
  createThermalOverlayMaterial,
  createThermalColorLegend
}
