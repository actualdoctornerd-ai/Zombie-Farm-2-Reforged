import{w as m,g as c,S as s}from"./index-Doo4b5cf.js";const l={name:"texture-bit",vertex:{header:`

        struct TextureUniforms {
            uTextureMatrix:mat3x3<f32>,
        }

        @group(2) @binding(2) var<uniform> textureUniforms : TextureUniforms;
        `,main:`
            uv = (textureUniforms.uTextureMatrix * vec3(uv, 1.0)).xy;
        `},fragment:{header:`
            @group(2) @binding(0) var uTexture: texture_2d<f32>;
            @group(2) @binding(1) var uSampler: sampler;


        `,main:`
            outColor = textureSample(uTexture, uSampler, vUV);
        `}},x={name:"texture-bit",vertex:{header:`
            uniform mat3 uTextureMatrix;
        `,main:`
            uv = (uTextureMatrix * vec3(uv, 1.0)).xy;
        `},fragment:{header:`
        uniform sampler2D uTexture;


        `,main:`
            outColor = texture(uTexture, vUV);
        `}};function d(n,o){for(const r in n.attributes){const e=n.attributes[r],a=o[r];a?(e.format??(e.format=a.format),e.offset??(e.offset=a.offset),e.instance??(e.instance=a.instance)):m(`Attribute ${r} is not present in the shader, but is present in the geometry. Unable to infer attribute details.`)}p(n)}function p(n){const{buffers:o,attributes:r}=n,e={},a={};for(const u in o){const t=o[u];e[t.uid]=0,a[t.uid]=0}for(const u in r){const t=r[u];e[t.buffer.uid]+=c(t.format).stride}for(const u in r){const t=r[u];t.stride??(t.stride=e[t.buffer.uid]),t.start??(t.start=a[t.buffer.uid]),a[t.buffer.uid]+=c(t.format).stride}}const i=[];i[s.NONE]=void 0;i[s.DISABLED]={stencilWriteMask:0,stencilReadMask:0};i[s.RENDERING_MASK_ADD]={stencilFront:{compare:"equal",passOp:"increment-clamp"},stencilBack:{compare:"equal",passOp:"increment-clamp"}};i[s.RENDERING_MASK_REMOVE]={stencilFront:{compare:"equal",passOp:"decrement-clamp"},stencilBack:{compare:"equal",passOp:"decrement-clamp"}};i[s.MASK_ACTIVE]={stencilWriteMask:0,stencilFront:{compare:"equal",passOp:"keep"},stencilBack:{compare:"equal",passOp:"keep"}};i[s.INVERSE_MASK_ACTIVE]={stencilWriteMask:0,stencilFront:{compare:"not-equal",passOp:"keep"},stencilBack:{compare:"not-equal",passOp:"keep"}};export{i as G,x as a,d as e,l as t};
//# sourceMappingURL=GpuStencilModesToPixi-Cs5mtxlQ.js.map
