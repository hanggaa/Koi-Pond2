import { Vector2, Color, WebGLRenderTarget, Float32BufferAttribute, OrthographicCamera, BufferGeometry, Mesh, UniformsUtils, ShaderMaterial, Vector3, AdditiveBlending, MeshBasicMaterial } from 'three'

/**
 * Luminosity
 * http://en.wikipedia.org/wiki/Luminosity
 */

const LuminosityHighPassShader = {
  shaderID: 'luminosityHighPass',
  uniforms: {
    tDiffuse: {
      value: null
    },
    luminosityThreshold: {
      value: 1.0
    },
    smoothWidth: {
      value: 1.0
    },
    defaultColor: {
      value: new Color(0x000000)
    },
    defaultOpacity: {
      value: 0.0
    }
  },
  vertexShader: /* glsl */`

		varying vec2 vUv;

		void main() {

			vUv = uv;

			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

		}`,
  fragmentShader: /* glsl */`

		uniform sampler2D tDiffuse;
		uniform vec3 defaultColor;
		uniform float defaultOpacity;
		uniform float luminosityThreshold;
		uniform float smoothWidth;

		varying vec2 vUv;

		void main() {

			vec4 texel = texture2D( tDiffuse, vUv );

			vec3 luma = vec3( 0.299, 0.587, 0.114 );

			float v = dot( texel.xyz, luma );

			vec4 outputColor = vec4( defaultColor.rgb, defaultOpacity );

			float alpha = smoothstep( luminosityThreshold, luminosityThreshold + smoothWidth, v );

			gl_FragColor = mix( outputColor, texel, alpha );

		}`
}

/**
 * Full-screen textured quad shader
 */

const CopyShader = {
  uniforms: {
    tDiffuse: {
      value: null
    },
    opacity: {
      value: 1.0
    }
  },
  vertexShader: /* glsl */`

		varying vec2 vUv;

		void main() {

			vUv = uv;
			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

		}`,
  fragmentShader: /* glsl */`

		uniform float opacity;

		uniform sampler2D tDiffuse;

		varying vec2 vUv;

		void main() {

			gl_FragColor = texture2D( tDiffuse, vUv );
			gl_FragColor.a *= opacity;


		}`
}

class Pass {
  constructor () {
    // if set to true, the pass is processed by the composer
    this.enabled = true

    // if set to true, the pass indicates to swap read and write buffer after rendering
    this.needsSwap = true

    // if set to true, the pass clears its buffer before rendering
    this.clear = false

    // if set to true, the result of the pass is rendered to screen. This is set automatically by EffectComposer.
    this.renderToScreen = false

    this.BlurDirectionX = new Vector2(1.0, 0.0)
    this.BlurDirectionY = new Vector2(0.0, 1.0)
  }

  setSize () {}
  render () {
    console.error('Pass: .render() must be implemented in derived pass.')
  }

  dispose () {}
}

// Helper for passes that need to fill the viewport with a single quad.

const _camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)

// https://github.com/mrdoob/js/pull/21358

const _geometry = new BufferGeometry()
_geometry.setAttribute('position', new Float32BufferAttribute([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3))
_geometry.setAttribute('uv', new Float32BufferAttribute([0, 2, 0, 0, 2, 0], 2))
class FullScreenQuad {
  constructor (material) {
    this._mesh = new Mesh(_geometry, material)
  }

  dispose () {
    this._mesh.geometry.dispose()
  }

  render (renderer) {
    renderer.render(this._mesh, _camera)
  }

  get material () {
    return this._mesh.material
  }

  set material (value) {
    this._mesh.material = value
  }
}

/**
 * UnrealBloomPass is inspired by the bloom pass of Unreal Engine. It creates a
 * mip map chain of bloom textures and blurs them with different radii. Because
 * of the weighted combination of mips, and because larger blurs are done on
 * higher mips, this effect provides good quality and performance.
 *
 * Reference:
 * - https://docs.unrealengine.com/latest/INT/Engine/Rendering/PostProcessEffects/Bloom/
 */
export default class UnrealBloomPass extends Pass {
  constructor (resolution, strength, radius, threshold) {
    super()
    this.strength = strength !== undefined ? strength : 1
    this.radius = radius
    this.threshold = threshold
    this.resolution = resolution !== undefined ? new Vector2(resolution.x, resolution.y) : new Vector2(256, 256)

    // create color only once here, reuse it later inside the render function
    this.clearColor = new Color(0, 0, 0)

    // render targets
    this.renderTargetsHorizontal = []
    this.renderTargetsVertical = []
    this.nMips = 5
    let resx = Math.round(this.resolution.x / 2)
    let resy = Math.round(this.resolution.y / 2)
    this.renderTargetBright = new WebGLRenderTarget(resx, resy)
    this.renderTargetBright.texture.name = 'UnrealBloomPass.bright'
    this.renderTargetBright.texture.generateMipmaps = false
    for (let i = 0; i < this.nMips; i++) {
      const renderTargetHorizonal = new WebGLRenderTarget(resx, resy)
      renderTargetHorizonal.texture.name = 'UnrealBloomPass.h' + i
      renderTargetHorizonal.texture.generateMipmaps = false
      this.renderTargetsHorizontal.push(renderTargetHorizonal)
      const renderTargetVertical = new WebGLRenderTarget(resx, resy)
      renderTargetVertical.texture.name = 'UnrealBloomPass.v' + i
      renderTargetVertical.texture.generateMipmaps = false
      this.renderTargetsVertical.push(renderTargetVertical)
      resx = Math.round(resx / 2)
      resy = Math.round(resy / 2)
    }

    // luminosity high pass material

    if (LuminosityHighPassShader === undefined) console.error('UnrealBloomPass relies on LuminosityHighPassShader')
    const highPassShader = LuminosityHighPassShader
    this.highPassUniforms = UniformsUtils.clone(highPassShader.uniforms)
    this.highPassUniforms.luminosityThreshold.value = threshold
    this.highPassUniforms.smoothWidth.value = 0.01
    this.materialHighPassFilter = new ShaderMaterial({
      uniforms: this.highPassUniforms,
      vertexShader: highPassShader.vertexShader,
      fragmentShader: highPassShader.fragmentShader,
      defines: {}
    })

    // Gaussian Blur Materials
    this.separableBlurMaterials = []
    const kernelSizeArray = [3, 5, 7, 9, 11]
    resx = Math.round(this.resolution.x / 2)
    resy = Math.round(this.resolution.y / 2)
    for (let i = 0; i < this.nMips; i++) {
      this.separableBlurMaterials.push(this.getSeperableBlurMaterial(kernelSizeArray[i]))
      this.separableBlurMaterials[i].uniforms.texSize.value = new Vector2(resx, resy)
      resx = Math.round(resx / 2)
      resy = Math.round(resy / 2)
    }

    // Composite material
    this.compositeMaterial = this.getCompositeMaterial(this.nMips)
    this.compositeMaterial.uniforms.blurTexture1.value = this.renderTargetsVertical[0].texture
    this.compositeMaterial.uniforms.blurTexture2.value = this.renderTargetsVertical[1].texture
    this.compositeMaterial.uniforms.blurTexture3.value = this.renderTargetsVertical[2].texture
    this.compositeMaterial.uniforms.blurTexture4.value = this.renderTargetsVertical[3].texture
    this.compositeMaterial.uniforms.blurTexture5.value = this.renderTargetsVertical[4].texture
    this.compositeMaterial.uniforms.bloomStrength.value = strength
    this.compositeMaterial.uniforms.bloomRadius.value = 0.1
    this.compositeMaterial.needsUpdate = true
    const bloomFactors = [1.0, 0.8, 0.6, 0.4, 0.2]
    this.compositeMaterial.uniforms.bloomFactors.value = bloomFactors
    this.bloomTintColors = [new Vector3(1, 1, 1), new Vector3(1, 1, 1), new Vector3(1, 1, 1), new Vector3(1, 1, 1), new Vector3(1, 1, 1)]
    this.compositeMaterial.uniforms.bloomTintColors.value = this.bloomTintColors

    // copy material
    if (CopyShader === undefined) {
      console.error('UnrealBloomPass relies on CopyShader')
    }

    const copyShader = CopyShader
    this.copyUniforms = UniformsUtils.clone(copyShader.uniforms)
    this.copyUniforms.opacity.value = 1.0
    this.materialCopy = new ShaderMaterial({
      uniforms: this.copyUniforms,
      vertexShader: copyShader.vertexShader,
      fragmentShader: copyShader.fragmentShader,
      blending: AdditiveBlending,
      depthTest: false,
      depthWrite: false,
      transparent: true
    })
    this.enabled = true
    this.needsSwap = false
    this._oldClearColor = new Color()
    this.oldClearAlpha = 1
    this.basic = new MeshBasicMaterial()
    this.fsQuad = new FullScreenQuad(null)
  }

  dispose () {
    for (let i = 0; i < this.renderTargetsHorizontal.length; i++) {
      this.renderTargetsHorizontal[i].dispose()
    }

    for (let i = 0; i < this.renderTargetsVertical.length; i++) {
      this.renderTargetsVertical[i].dispose()
    }

    this.renderTargetBright.dispose()

    //

    for (let i = 0; i < this.separableBlurMaterials.length; i++) {
      this.separableBlurMaterials[i].dispose()
    }

    this.compositeMaterial.dispose()
    this.materialCopy.dispose()
    this.basic.dispose()

    //

    this.fsQuad.dispose()
  }

  setSize (width, height) {
    let resx = Math.round(width / 2)
    let resy = Math.round(height / 2)
    this.renderTargetBright.setSize(resx, resy)
    for (let i = 0; i < this.nMips; i++) {
      this.renderTargetsHorizontal[i].setSize(resx, resy)
      this.renderTargetsVertical[i].setSize(resx, resy)
      this.separableBlurMaterials[i].uniforms.texSize.value = new Vector2(resx, resy)
      resx = Math.round(resx / 2)
      resy = Math.round(resy / 2)
    }
  }

  render (renderer, writeBuffer, readBuffer, deltaTime, maskActive) {
    renderer.getClearColor(this._oldClearColor)
    this.oldClearAlpha = renderer.getClearAlpha()
    const oldAutoClear = renderer.autoClear
    renderer.autoClear = false
    renderer.setClearColor(this.clearColor, 0)
    if (maskActive) renderer.state.buffers.stencil.setTest(false)

    // Render input to screen

    if (this.renderToScreen) {
      this.fsQuad.material = this.basic
      this.basic.map = readBuffer.texture
      renderer.setRenderTarget(null)
      renderer.clear()
      this.fsQuad.render(renderer)
    }

    // 1. Extract Bright Areas

    this.highPassUniforms.tDiffuse.value = readBuffer.texture
    this.highPassUniforms.luminosityThreshold.value = this.threshold
    this.fsQuad.material = this.materialHighPassFilter
    renderer.setRenderTarget(this.renderTargetBright)
    renderer.clear()
    this.fsQuad.render(renderer)

    // 2. Blur All the mips progressively

    let inputRenderTarget = this.renderTargetBright
    for (let i = 0; i < this.nMips; i++) {
      this.fsQuad.material = this.separableBlurMaterials[i]
      this.separableBlurMaterials[i].uniforms.colorTexture.value = inputRenderTarget.texture
      this.separableBlurMaterials[i].uniforms.direction.value = this.BlurDirectionX
      renderer.setRenderTarget(this.renderTargetsHorizontal[i])
      renderer.clear()
      this.fsQuad.render(renderer)
      this.separableBlurMaterials[i].uniforms.colorTexture.value = this.renderTargetsHorizontal[i].texture
      this.separableBlurMaterials[i].uniforms.direction.value = this.BlurDirectionY
      renderer.setRenderTarget(this.renderTargetsVertical[i])
      renderer.clear()
      this.fsQuad.render(renderer)
      inputRenderTarget = this.renderTargetsVertical[i]
    }

    // Composite All the mips

    this.fsQuad.material = this.compositeMaterial
    this.compositeMaterial.uniforms.bloomStrength.value = this.strength
    this.compositeMaterial.uniforms.bloomRadius.value = this.radius
    this.compositeMaterial.uniforms.bloomTintColors.value = this.bloomTintColors
    renderer.setRenderTarget(this.renderTargetsHorizontal[0])
    renderer.clear()
    this.fsQuad.render(renderer)

    // Blend it additively over the input texture

    this.fsQuad.material = this.materialCopy
    this.copyUniforms.tDiffuse.value = this.renderTargetsHorizontal[0].texture
    if (maskActive) renderer.state.buffers.stencil.setTest(true)
    if (this.renderToScreen) {
      renderer.setRenderTarget(null)
      this.fsQuad.render(renderer)
    } else {
      renderer.setRenderTarget(readBuffer)
      this.fsQuad.render(renderer)
    }

    // Restore renderer settings

    renderer.setClearColor(this._oldClearColor, this.oldClearAlpha)
    renderer.autoClear = oldAutoClear
  }

  getSeperableBlurMaterial (kernelRadius) {
    return new ShaderMaterial({
      defines: {
        KERNEL_RADIUS: kernelRadius,
        SIGMA: kernelRadius
      },
      uniforms: {
        colorTexture: {
          value: null
        },
        texSize: {
          value: new Vector2(0.5, 0.5)
        },
        direction: {
          value: new Vector2(0.5, 0.5)
        }
      },
      vertexShader: `varying vec2 vUv;
				void main() {
					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
				}`,
      fragmentShader: `#include <common>
				varying vec2 vUv;
				uniform sampler2D colorTexture;
				uniform vec2 texSize;
				uniform vec2 direction;

				float gaussianPdf(in float x, in float sigma) {
					return 0.39894 * exp( -0.5 * x * x/( sigma * sigma))/sigma;
				}
				void main() {
					vec2 invSize = 1.0 / texSize;
					float fSigma = float(SIGMA);
					float weightSum = gaussianPdf(0.0, fSigma);
					vec3 diffuseSum = texture2D( colorTexture, vUv).rgb * weightSum;
					for( int i = 1; i < KERNEL_RADIUS; i ++ ) {
						float x = float(i);
						float w = gaussianPdf(x, fSigma);
						vec2 uvOffset = direction * invSize * x;
						vec3 sample1 = texture2D( colorTexture, vUv + uvOffset).rgb;
						vec3 sample2 = texture2D( colorTexture, vUv - uvOffset).rgb;
						diffuseSum += (sample1 + sample2) * w;
						weightSum += 2.0 * w;
					}
					gl_FragColor = vec4(diffuseSum/weightSum, 1.0);
				}`
    })
  }

  getCompositeMaterial (nMips) {
    return new ShaderMaterial({
      defines: {
        NUM_MIPS: nMips
      },
      uniforms: {
        blurTexture1: {
          value: null
        },
        blurTexture2: {
          value: null
        },
        blurTexture3: {
          value: null
        },
        blurTexture4: {
          value: null
        },
        blurTexture5: {
          value: null
        },
        bloomStrength: {
          value: 1.0
        },
        bloomFactors: {
          value: null
        },
        bloomTintColors: {
          value: null
        },
        bloomRadius: {
          value: 0.0
        }
      },
      vertexShader: `varying vec2 vUv;
				void main() {
					vUv = uv;
					gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
				}`,
      fragmentShader: `varying vec2 vUv;
				uniform sampler2D blurTexture1;
				uniform sampler2D blurTexture2;
				uniform sampler2D blurTexture3;
				uniform sampler2D blurTexture4;
				uniform sampler2D blurTexture5;
				uniform float bloomStrength;
				uniform float bloomRadius;
				uniform float bloomFactors[NUM_MIPS];
				uniform vec3 bloomTintColors[NUM_MIPS];

				float lerpBloomFactor(const in float factor) {
					float mirrorFactor = 1.2 - factor;
					return mix(factor, mirrorFactor, bloomRadius);
				}

				void main() {
					gl_FragColor = bloomStrength * ( lerpBloomFactor(bloomFactors[0]) * vec4(bloomTintColors[0], 1.0) * texture2D(blurTexture1, vUv) +
						lerpBloomFactor(bloomFactors[1]) * vec4(bloomTintColors[1], 1.0) * texture2D(blurTexture2, vUv) +
						lerpBloomFactor(bloomFactors[2]) * vec4(bloomTintColors[2], 1.0) * texture2D(blurTexture3, vUv) +
						lerpBloomFactor(bloomFactors[3]) * vec4(bloomTintColors[3], 1.0) * texture2D(blurTexture4, vUv) +
						lerpBloomFactor(bloomFactors[4]) * vec4(bloomTintColors[4], 1.0) * texture2D(blurTexture5, vUv) );
				}`
    })
  }
}
