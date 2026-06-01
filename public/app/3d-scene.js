/**
 * 溪语AI - 3D 樱花粒子场景
 * 使用 Three.js 创建沉浸式 Hero 背景
 * 支持深色/浅色主题切换
 */

(function() {
  'use strict';

  // 检查 Three.js 是否可用
  if (typeof THREE === 'undefined') {
    console.warn('[v0] Three.js not loaded, skipping 3D scene');
    return;
  }

  // 移动端检测 - 低性能设备降级
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  const isLowPerf = isMobile || (navigator.hardwareConcurrency && navigator.hardwareConcurrency < 4);

  // 主题检测
  function isDarkMode() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ||
           document.documentElement.classList.contains('dark');
  }

  // 颜色配置 - 支持主题切换
  const COLORS = {
    light: {
      sakura: ['#FFB6D9', '#FF8FB8', '#FFD4E8', '#FFC4DC'],
      glow: ['#FFE8F2', '#B8D4FF', '#FFD4E8', '#E8D4FF'],
      star: '#ffffff'
    },
    dark: {
      sakura: ['#FF6B9D', '#FF4081', '#FF85AB', '#FF5C8D'],
      glow: ['#FF85AB', '#6B8CFF', '#A855F7', '#22D3EE'],
      star: '#ffffff'
    }
  };

  function getColors() {
    return isDarkMode() ? COLORS.dark : COLORS.light;
  }

  // 配置参数
  const CONFIG = {
    sakuraCount: isLowPerf ? 30 : 60,
    glowCount: isLowPerf ? 60 : 120,
    starCount: isLowPerf ? 80 : 200,
    mouseInfluence: 0.0008,
    sakuraSize: isLowPerf ? 12 : 16,
    glowSize: isLowPerf ? 6 : 8,
    starSize: isLowPerf ? 2 : 3,
  };

  // 获取 Hero 区域
  const heroSection = document.getElementById('hero');
  if (!heroSection) return;

  // 创建 Canvas 容器
  const canvas = document.createElement('canvas');
  canvas.id = 'hero-3d-canvas';
  canvas.style.cssText = `
    position: absolute;
    inset: 0;
    z-index: 0;
    pointer-events: none;
    width: 100%;
    height: 100%;
  `;
  
  // 插入到 hero 的最前面
  heroSection.style.position = 'relative';
  heroSection.insertBefore(canvas, heroSection.firstChild);

  // Three.js 场景初始化
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.z = 50;

  const renderer = new THREE.WebGLRenderer({
    canvas: canvas,
    alpha: true,
    antialias: !isLowPerf,
    powerPreference: isLowPerf ? 'low-power' : 'high-performance'
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isLowPerf ? 1.5 : 2));
  renderer.setClearColor(0x000000, 0);

  // 鼠标位置追踪
  const mouse = { x: 0, y: 0, targetX: 0, targetY: 0 };

  // ========================
  // 1. 樱花粒子系统
  // ========================
  function createSakuraParticles() {
    const geometry = new THREE.BufferGeometry();
    const count = CONFIG.sakuraCount;
    
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const velocities = new Float32Array(count * 3);
    const rotations = new Float32Array(count);
    
    // 使用当前主题颜色
    const currentColors = getColors();
    const sakuraColors = currentColors.sakura.map(c => new THREE.Color(c));

    for (let i = 0; i < count; i++) {
      // 分布在屏幕上方和两侧
      positions[i * 3] = (Math.random() - 0.5) * 100;      // x
      positions[i * 3 + 1] = Math.random() * 80 + 20;      // y (上方)
      positions[i * 3 + 2] = (Math.random() - 0.5) * 50;   // z
      
      // 随机颜色
      const color = sakuraColors[Math.floor(Math.random() * sakuraColors.length)];
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
      
      // 随机大小
      sizes[i] = Math.random() * CONFIG.sakuraSize + 8;
      
      // 飘落速度
      velocities[i * 3] = (Math.random() - 0.5) * 0.02;    // x drift
      velocities[i * 3 + 1] = -Math.random() * 0.08 - 0.02; // y fall
      velocities[i * 3 + 2] = (Math.random() - 0.5) * 0.01; // z drift
      
      // 旋转速度
      rotations[i] = (Math.random() - 0.5) * 0.02;
    }
    
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    
    // 自定义 Shader 实现樱花花瓣
    const sakuraMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uMouse: { value: new THREE.Vector2(0, 0) },
      },
      vertexShader: `
        attribute float size;
        attribute vec3 color;
        varying vec3 vColor;
        varying float vAlpha;
        uniform float uTime;
        uniform vec2 uMouse;
        
        void main() {
          vColor = color;
          
          vec3 pos = position;
          
          // 添加波浪摇摆
          pos.x += sin(uTime * 0.5 + position.y * 0.1) * 2.0;
          pos.z += cos(uTime * 0.3 + position.x * 0.1) * 1.5;
          
          // 鼠标影响
          float dist = length(vec2(pos.x, pos.y) - uMouse * 50.0);
          pos.x += (uMouse.x * 50.0 - pos.x) * 0.02 / (dist * 0.1 + 1.0);
          pos.y += (uMouse.y * 50.0 - pos.y) * 0.02 / (dist * 0.1 + 1.0);
          
          // 透明度基于位置
          vAlpha = smoothstep(-40.0, 20.0, pos.y) * 0.7;
          
          vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
          gl_PointSize = size * (300.0 / -mvPosition.z);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vAlpha;
        
        void main() {
          // 花瓣形状
          vec2 center = gl_PointCoord - vec2(0.5);
          float dist = length(center);
          
          // 花瓣轮廓 - 心形变体
          float angle = atan(center.y, center.x);
          float petalShape = 0.5 + 0.2 * sin(angle * 2.0 + 1.57);
          
          float alpha = smoothstep(petalShape, petalShape - 0.15, dist);
          alpha *= vAlpha;
          
          if (alpha < 0.01) discard;
          
          // 中心渐变
          vec3 finalColor = mix(vColor, vec3(1.0), smoothstep(0.3, 0.0, dist) * 0.3);
          
          gl_FragColor = vec4(finalColor, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    
    const particles = new THREE.Points(geometry, sakuraMaterial);
    particles.userData = { velocities, rotations };
    scene.add(particles);
    
    return particles;
  }

  // ========================
  // 2. 光点粒子系统
  // ========================
  function createGlowParticles() {
    const geometry = new THREE.BufferGeometry();
    const count = CONFIG.glowCount;
    
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const phases = new Float32Array(count);
    
    // 使用当前主题颜色
    const currentColors = getColors();
    const glowColors = currentColors.glow.map(c => new THREE.Color(c));

    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 120;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 80;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 60 - 10;
      
      const color = glowColors[Math.floor(Math.random() * glowColors.length)];
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
      
      sizes[i] = Math.random() * CONFIG.glowSize + 3;
      phases[i] = Math.random() * Math.PI * 2;
    }
    
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('phase', new THREE.BufferAttribute(phases, 1));
    
    const glowMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uMouse: { value: new THREE.Vector2(0, 0) },
      },
      vertexShader: `
        attribute float size;
        attribute vec3 color;
        attribute float phase;
        varying vec3 vColor;
        varying float vAlpha;
        uniform float uTime;
        uniform vec2 uMouse;
        
        void main() {
          vColor = color;
          
          vec3 pos = position;
          
          // 缓慢漂浮
          pos.x += sin(uTime * 0.2 + phase) * 3.0;
          pos.y += cos(uTime * 0.15 + phase * 1.3) * 2.0;
          pos.z += sin(uTime * 0.1 + phase * 0.7) * 2.0;
          
          // 鼠标推开效果
          vec2 mouseWorld = uMouse * 40.0;
          float dist = length(vec2(pos.x, pos.y) - mouseWorld);
          float push = 8.0 / (dist * 0.5 + 1.0);
          pos.x += (pos.x - mouseWorld.x) * push * 0.01;
          pos.y += (pos.y - mouseWorld.y) * push * 0.01;
          
          // 闪烁透明度
          vAlpha = (sin(uTime * 2.0 + phase * 3.0) * 0.3 + 0.7) * 0.5;
          
          vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
          gl_PointSize = size * (250.0 / -mvPosition.z);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        varying float vAlpha;
        
        void main() {
          float dist = length(gl_PointCoord - vec2(0.5));
          float alpha = smoothstep(0.5, 0.0, dist) * vAlpha;
          
          if (alpha < 0.01) discard;
          
          gl_FragColor = vec4(vColor, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    
    const particles = new THREE.Points(geometry, glowMaterial);
    scene.add(particles);
    
    return particles;
  }

  // ========================
  // 3. 星尘背景
  // ========================
  function createStarDust() {
    const geometry = new THREE.BufferGeometry();
    const count = CONFIG.starCount;
    
    const positions = new Float32Array(count * 3);
    const sizes = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 150;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 100;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 80 - 20;
      
      sizes[i] = Math.random() * CONFIG.starSize + 1;
    }
    
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    
    const starMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
      },
      vertexShader: `
        attribute float size;
        varying float vAlpha;
        uniform float uTime;
        
        void main() {
          // 轻微闪烁
          vAlpha = (sin(uTime * 0.5 + position.x * 0.1) * 0.3 + 0.7) * 0.15;
          
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * (200.0 / -mvPosition.z);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying float vAlpha;
        
        void main() {
          float dist = length(gl_PointCoord - vec2(0.5));
          float alpha = smoothstep(0.5, 0.0, dist) * vAlpha;
          
          if (alpha < 0.005) discard;
          
          gl_FragColor = vec4(1.0, 1.0, 1.0, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
    });
    
    const particles = new THREE.Points(geometry, starMaterial);
    scene.add(particles);
    
    return particles;
  }

  // 创建所有粒子系统
  const sakuraParticles = createSakuraParticles();
  const glowParticles = createGlowParticles();
  const starDust = createStarDust();

  // ========================
  // 动画循环
  // ========================
  let time = 0;
  let isVisible = true;
  let animationId;

  function updateSakuraPositions() {
    const positions = sakuraParticles.geometry.attributes.position.array;
    const velocities = sakuraParticles.userData.velocities;
    
    for (let i = 0; i < positions.length / 3; i++) {
      // 更新位置
      positions[i * 3] += velocities[i * 3];
      positions[i * 3 + 1] += velocities[i * 3 + 1];
      positions[i * 3 + 2] += velocities[i * 3 + 2];
      
      // 重置落出画面的粒子
      if (positions[i * 3 + 1] < -50) {
        positions[i * 3] = (Math.random() - 0.5) * 100;
        positions[i * 3 + 1] = 60 + Math.random() * 20;
        positions[i * 3 + 2] = (Math.random() - 0.5) * 50;
      }
    }
    
    sakuraParticles.geometry.attributes.position.needsUpdate = true;
  }

  function animate() {
    if (!isVisible) {
      animationId = requestAnimationFrame(animate);
      return;
    }
    
    time += 0.016;
    
    // 平滑鼠标追踪
    mouse.x += (mouse.targetX - mouse.x) * 0.05;
    mouse.y += (mouse.targetY - mouse.y) * 0.05;
    
    // 更新 uniforms
    sakuraParticles.material.uniforms.uTime.value = time;
    sakuraParticles.material.uniforms.uMouse.value.set(mouse.x, mouse.y);
    
    glowParticles.material.uniforms.uTime.value = time;
    glowParticles.material.uniforms.uMouse.value.set(mouse.x, mouse.y);
    
    starDust.material.uniforms.uTime.value = time;
    
    // 更新樱花位置
    updateSakuraPositions();
    
    // 场景轻微随鼠标旋转
    scene.rotation.x = mouse.y * 0.05;
    scene.rotation.y = mouse.x * 0.05;
    
    renderer.render(scene, camera);
    animationId = requestAnimationFrame(animate);
  }

  // ========================
  // 事件监听
  // ========================
  
  // 鼠标移动
  document.addEventListener('mousemove', (e) => {
    mouse.targetX = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.targetY = -(e.clientY / window.innerHeight) * 2 + 1;
  });

  // 触摸支持
  document.addEventListener('touchmove', (e) => {
    if (e.touches.length > 0) {
      mouse.targetX = (e.touches[0].clientX / window.innerWidth) * 2 - 1;
      mouse.targetY = -(e.touches[0].clientY / window.innerHeight) * 2 + 1;
    }
  }, { passive: true });

  // 窗口大小改变
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // 视口检测 - 离开 Hero 区域时暂停渲染
  const heroObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      isVisible = entry.isIntersecting;
    });
  }, { threshold: 0.1 });
  
  heroObserver.observe(heroSection);

  // 启动动画
  animate();

  // 清理函数（如果需要）
  window.xiyu3DScene = {
    destroy: function() {
      cancelAnimationFrame(animationId);
      heroObserver.disconnect();
      renderer.dispose();
      scene.clear();
      canvas.remove();
    },
    // 主题切换时更新颜色
    updateColors: function() {
      const currentColors = getColors();
      
      // 更新樱花颜色
      const sakuraColorArr = sakuraParticles.geometry.attributes.color.array;
      const sakuraColorPalette = currentColors.sakura.map(c => new THREE.Color(c));
      for (let i = 0; i < CONFIG.sakuraCount; i++) {
        const color = sakuraColorPalette[Math.floor(Math.random() * sakuraColorPalette.length)];
        sakuraColorArr[i * 3] = color.r;
        sakuraColorArr[i * 3 + 1] = color.g;
        sakuraColorArr[i * 3 + 2] = color.b;
      }
      sakuraParticles.geometry.attributes.color.needsUpdate = true;
      
      // 更新光点颜色
      const glowColorArr = glowParticles.geometry.attributes.color.array;
      const glowColorPalette = currentColors.glow.map(c => new THREE.Color(c));
      for (let i = 0; i < CONFIG.glowCount; i++) {
        const color = glowColorPalette[Math.floor(Math.random() * glowColorPalette.length)];
        glowColorArr[i * 3] = color.r;
        glowColorArr[i * 3 + 1] = color.g;
        glowColorArr[i * 3 + 2] = color.b;
      }
      glowParticles.geometry.attributes.color.needsUpdate = true;
    }
  };

  // 监听主题变化
  const themeObserver = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      if (mutation.attributeName === 'data-theme' || mutation.attributeName === 'class') {
        window.xiyu3DScene.updateColors();
      }
    });
  });
  
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'class']
  });

})();
