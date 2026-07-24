import{w as m,g as l,c as a}from"./index-DqEW435L.js";const c={name:"local-uniform-bit",vertex:{header:`

            struct LocalUniforms {
                uTransformMatrix:mat3x3<f32>,
                uColor:vec4<f32>,
                uRound:f32,
            }

            @group(1) @binding(0) var<uniform> localUniforms : LocalUniforms;
        `,main:`
            vColor *= localUniforms.uColor;
            modelMatrix *= localUniforms.uTransformMatrix;
        `,end:`
            if(localUniforms.uRound == 1)
            {
                vPosition = vec4(roundPixels(vPosition.xy, globalUniforms.uResolution), vPosition.zw);
            }
        `}},x={...c,vertex:{...c.vertex,header:c.vertex.header.replace("group(1)","group(2)")}},d={name:"local-uniform-bit",vertex:{header:`

            uniform mat3 uTransformMatrix;
            uniform vec4 uColor;
            uniform float uRound;
        `,main:`
            vColor *= uColor;
            modelMatrix = uTransformMatrix;
        `,end:`
            if(uRound == 1.)
            {
                gl_Position.xy = roundPixels(gl_Position.xy, uResolution);
            }
        `}},b={name:"texture-bit",vertex:{header:`

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
        `}},v={name:"texture-bit",vertex:{header:`
            uniform mat3 uTextureMatrix;
        `,main:`
            uv = (uTextureMatrix * vec3(uv, 1.0)).xy;
        `},fragment:{header:`
        uniform sampler2D uTexture;


        `,main:`
            outColor = texture(uTexture, vUV);
        `}};function M(n,u){for(const r in n.attributes){const t=n.attributes[r],o=u[r];o?(t.format??(t.format=o.format),t.offset??(t.offset=o.offset),t.instance??(t.instance=o.instance)):m(`Attribute ${r} is not present in the shader, but is present in the geometry. Unable to infer attribute details.`)}f(n)}function f(n){const{buffers:u,attributes:r}=n,t={},o={};for(const s in u){const e=u[s];t[e.uid]=0,o[e.uid]=0}for(const s in r){const e=r[s];t[e.buffer.uid]+=l(e.format).stride}for(const s in r){const e=r[s];e.stride??(e.stride=t[e.buffer.uid]),e.start??(e.start=o[e.buffer.uid]),o[e.buffer.uid]+=l(e.format).stride}}const i=[];i[a.NONE]=void 0;i[a.DISABLED]={stencilWriteMask:0,stencilReadMask:0};i[a.RENDERING_MASK_ADD]={stencilFront:{compare:"equal",passOp:"increment-clamp"},stencilBack:{compare:"equal",passOp:"increment-clamp"}};i[a.RENDERING_MASK_REMOVE]={stencilFront:{compare:"equal",passOp:"decrement-clamp"},stencilBack:{compare:"equal",passOp:"decrement-clamp"}};i[a.MASK_ACTIVE]={stencilWriteMask:0,stencilFront:{compare:"equal",passOp:"keep"},stencilBack:{compare:"equal",passOp:"keep"}};i[a.INVERSE_MASK_ACTIVE]={stencilWriteMask:0,stencilFront:{compare:"not-equal",passOp:"keep"},stencilBack:{compare:"not-equal",passOp:"keep"}};export{i as G,c as a,d as b,v as c,M as e,x as l,b as t};
