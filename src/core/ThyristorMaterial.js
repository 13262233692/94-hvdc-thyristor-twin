import * as THREE from 'three'
import { THYRISTOR_MATERIAL_CONFIG } from './constants.js'

const vertexShader = /* glsl */`
  attribute vec3 instanceColor;
  attribute float aPulseState;
  attribute float aPulseIntensity;

  varying vec3 vNormal;
  varying vec3 vViewPosition;
  varying vec3 vInstanceColor;
  varying float vPulseState;
  varying float vPulseIntensity;
  varying vec3 vWorldPosition;

  uniform float uTime;

  void main() {
    vNormal = normalize(normalMatrix * normal);
    vInstanceColor = instanceColor;
    vPulseState = aPulseState;
    vPulseIntensity = aPulseIntensity;

    vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
    vViewPosition = -mvPosition.xyz;
    vWorldPosition = (modelMatrix * instanceMatrix * vec4(position, 1.0)).xyz;

    gl_Position = projectionMatrix * mvPosition;
  }
`

const fragmentShader = /* glsl */`
  uniform vec3 uBaseColor;
  uniform vec3 uPulseColor;
  uniform float uEmissiveIntensity;
  uniform float uTime;
  uniform float uDecayRate;

  varying vec3 vNormal;
  varying vec3 vViewPosition;
  varying vec3 vInstanceColor;
  varying float vPulseState;
  varying float vPulseIntensity;
  varying vec3 vWorldPosition;

  float rand(vec2 co) {
    return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);
  }

  void main() {
    vec3 normal = normalize(vNormal);
    vec3 viewDir = normalize(vViewPosition);

    float fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 2.5);

    vec3 baseColor = mix(uBaseColor, vInstanceColor, 0.5);
    vec3 finalColor = baseColor;
    vec3 emissive = vec3(0.0);

    float pulseIntensity = vPulseIntensity;
    float pulseState = vPulseState;

    if (pulseState > 0.5) {
      float sparkNoise = rand(vWorldPosition.xy * 10.0 + uTime * 50.0);
      float spark = sparkNoise * 0.3 + 0.7;
      
      vec3 pulseGlow = uPulseColor * pulseIntensity * uEmissiveIntensity * spark;
      
      float corona = fresnel * pulseIntensity * 2.0;
      vec3 coronaGlow = uPulseColor * corona * 0.8;
      
      emissive = pulseGlow + coronaGlow;
      finalColor = mix(baseColor, uPulseColor, min(pulseIntensity, 1.0) * 0.6);
    }

    vec3 lightDir = normalize(vec3(0.5, 1.0, 0.8));
    float diff = max(dot(normal, lightDir), 0.0);
    
    vec3 halfDir = normalize(lightDir + viewDir);
    float spec = pow(max(dot(normal, halfDir), 0.0), 64.0);
    
    vec3 ambient = baseColor * 0.3;
    vec3 diffuse = baseColor * diff * 0.7;
    vec3 specular = vec3(0.3) * spec;

    finalColor = ambient + diffuse + specular + emissive;

    if (pulseState > 0.5) {
      float bloom = pulseIntensity * 0.4;
      finalColor += uPulseColor * bloom;
    }

    gl_FragColor = vec4(finalColor, 1.0);
  }
`

export function createThyristorMaterial(options = {}) {
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uBaseColor: { value: options.baseColor || new THREE.Color(THYRISTOR_MATERIAL_CONFIG.BASE_COLOR) },
      uPulseColor: { value: options.pulseColor || new THREE.Color(THYRISTOR_MATERIAL_CONFIG.PULSE_COLOR) },
      uEmissiveIntensity: { value: THYRISTOR_MATERIAL_CONFIG.EMISSIVE_INTENSITY },
      uTime: { value: 0 },
      uDecayRate: { value: THYRISTOR_MATERIAL_CONFIG.DECAY_RATE }
    },
    lights: false,
    transparent: false,
    side: THREE.DoubleSide
  })

  material.isThyristorMaterial = true
  return material
}

export function updateThyristorPulseState(instancedMeshData, pulseEvents, deltaTime) {
  const { mesh, count } = instancedMeshData
  const instanceColor = mesh.instanceColor
  const pulseState = mesh.geometry.attributes.aPulseState
  const pulseIntensity = mesh.geometry.attributes.aPulseIntensity
  const decayRate = mesh.material.uniforms.uDecayRate.value

  for (let i = 0; i < count; i++) {
    let intensity = pulseIntensity.array[i]
    let state = pulseState.array[i]

    if (pulseEvents && pulseEvents.has(i)) {
      state = 1.0
      intensity = 1.0
      pulseEvents.delete(i)
    }

    if (intensity > 0.001) {
      intensity *= Math.pow(decayRate, deltaTime * 60)
      if (intensity < 0.001) {
        intensity = 0
        state = 0
      }
    }

    pulseState.array[i] = state
    pulseIntensity.array[i] = intensity

    if (state > 0.5) {
      const t = intensity
      instanceColor.array[i * 4] = 0.24 + t * 0.76
      instanceColor.array[i * 4 + 1] = 0.35 - t * 0.3
      instanceColor.array[i * 4 + 2] = 0.42 - t * 0.4
      instanceColor.array[i * 4 + 3] = 1.0
    } else {
      instanceColor.array[i * 4] = 0.24
      instanceColor.array[i * 4 + 1] = 0.35
      instanceColor.array[i * 4 + 2] = 0.42
      instanceColor.array[i * 4 + 3] = 1.0
    }
  }

  instanceColor.needsUpdate = true
  pulseState.needsUpdate = true
  pulseIntensity.needsUpdate = true
}

export function updateThyristorsFromSharedBuffer(meshData, pulseBuffer, deltaTime, meshIndex = 0) {
  const { mesh, count } = meshData
  const instanceColor = mesh.instanceColor
  const pulseState = mesh.geometry.attributes.aPulseState
  const pulseIntensity = mesh.geometry.attributes.aPulseIntensity
  const decayRate = mesh.material.uniforms.uDecayRate.value
  const decayFactor = Math.pow(decayRate, deltaTime * 60)

  const sharedState = pulseBuffer.state
  const sharedIntensity = pulseBuffer.intensity
  const totalThyristors = pulseBuffer.thyristorCount

  for (let i = 0; i < count; i++) {
    let state = 0
    let intensity = pulseIntensity.array[i]

    if (intensity > 0.001) {
      intensity *= decayFactor
      if (intensity < 0.001) {
        intensity = 0
      }
    }

    const globalId = i
    if (globalId < totalThyristors && sharedState[globalId] > 0) {
      state = 1
      intensity = sharedIntensity[globalId]
      if (intensity < 0.001) {
        intensity = 1.0
        sharedIntensity[globalId] = 1.0
      }
    }

    pulseState.array[i] = state
    pulseIntensity.array[i] = intensity

    if (state > 0.5) {
      const t = intensity
      instanceColor.array[i * 4] = 0.24 + t * 0.76
      instanceColor.array[i * 4 + 1] = 0.35 - t * 0.3
      instanceColor.array[i * 4 + 2] = 0.42 - t * 0.4
      instanceColor.array[i * 4 + 3] = 1.0
    } else {
      instanceColor.array[i * 4] = 0.24
      instanceColor.array[i * 4 + 1] = 0.35
      instanceColor.array[i * 4 + 2] = 0.42
      instanceColor.array[i * 4 + 3] = 1.0
    }
  }

  instanceColor.needsUpdate = true
  pulseState.needsUpdate = true
  pulseIntensity.needsUpdate = true
}

export { vertexShader, fragmentShader }
export default createThyristorMaterial
