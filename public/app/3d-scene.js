/**
 * 溪语AI - 极简 3D 光点场景
 * 高级感、克制、优雅的粒子效果
 * 支持深色/浅色主题切换
 */

(function() {
  'use strict';

  // 检查 Three.js 是否可用
  if (typeof THREE === 'undefined') {
    console.warn('[v0] Three.js not loaded, skipping 3D scene');
    return;
  }

  // 移动端检测
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);

  // 主题检测
  function isDarkMode() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ||
           document.documentElement.classList.contains('dark');
  }

  // 极简配色 - 只用 2-3 种颜色
  const COLORS = {
    light: {
      primary: '#FFB6D9',    // 主色：柔和樱花粉
      accent: '#E8D4FF',     // 点缀：淡紫
      glow: '#ffffff'        // 光晕：白色
    },
    dark: {
      primary: '#FF6B9D',    // 主色：霓虹粉
      accent: '#8B5CF6',     // 点缀：紫罗兰
      glow: '#ffffff'        // 光晕：白色
    }
  };

  function getColors() {
    return isDarkMode() ? COLORS.dark : COLORS.light;
  }

  // 极简配置 - 大幅减少粒子数量
  const CONFIG = {
    particleCount: isMobile ? 12 : 20,  // 极少的粒子
    mouseInfluence: 0.0003,              // 轻微的鼠标影响
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
    opacity: 0.7;
  `;
  
  heroSection.style.position = 'relative';
  heroSection.insertBefore(canvas, heroSection.firstChild);

  // Three.js 场景初始化
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.z = 80;

  const renderer = new THREE.WebGLRenderer({
    canvas: canvas,
    alpha: true,
    antialias: true,
    powerPreference: 'low-power'
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  // ========================
  // 极简光点粒子系统
  // ========================
  function createParticles() {
    const geometry = new THREE.BufferGeometry();
    const count = CONFIG.particleCount;
    
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const phases = new Float32Array(count);
    
    const currentColors = getColors();
    const primaryColor = new THREE.Color(currentColors.primary);
    const accentColor = new THREE.Color(currentColors.accent);

    for (let i = 0; i < count; i++) {
      // 更分散的分布，避免聚集
      positions[i * 3] = (Math.random() - 0.5) * 120;     // X
      positions[i * 3 + 1] = (Math.random() - 0.5) * 80;  // Y
      positions[i * 3 + 2] = (Math.random() - 0.5) * 40;  // Z
      
      // 70% 主色，30% 点缀色
      const color = Math.random() > 0.3 ? primaryColor : accentColor;
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
      
      // 大小差异更大，营造层次感
      sizes[i] = Math.random() * 8 + 3;
      phases[i] = Math.random() * Math.PI * 2;
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    geometry.userData.phases = phases;
    geometry.userData.initialPositions = positions.slice();

    // 简单的圆形粒子材质
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: renderer.getPixelRatio() }
      },
      vertexShader: `
        attribute float size;
        varying vec3 vColor;
        uniform float uTime;
        uniform float uPixelRatio;
        
        void main() {
          vColor = color;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * uPixelRatio * (80.0 / -mvPosition.z);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        
        void main() {
          // 柔和的圆形渐变
          float dist = length(gl_PointCoord - vec2(0.5));
          if (dist > 0.5) discard;
          
          // 中心亮，边缘柔和渐变
          float alpha = 1.0 - smoothstep(0.0, 0.5, dist);
          alpha = pow(alpha, 1.5); // 更柔和的衰减
          
          gl_FragColor = vec4(vColor, alpha * 0.6);
        }
      `,
      transparent: true,
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });

    return new THREE.Points(geometry, material);
  }

  const particles = createParticles();
  scene.add(particles);

  // 鼠标跟踪
  const mouse = { x: 0, y: 0, targetX: 0, targetY: 0 };
  
  function onMouseMove(e) {
    mouse.targetX = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.targetY = -(e.clientY / window.innerHeight) * 2 + 1;
  }
  
  // 移动端不监听鼠标
  if (!isMobile) {
    window.addEventListener('mousemove', onMouseMove, { passive: true });
  }

  // 窗口调整
  function onResize() {
    const width = window.innerWidth;
    const height = window.innerHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
  }
  window.addEventListener('resize', onResize, { passive: true });

  // 动画循环
  let animationId;
  let isVisible = true;
  const clock = new THREE.Clock();

  function animate() {
    if (!isVisible) {
      animationId = requestAnimationFrame(animate);
      return;
    }

    const elapsed = clock.getElapsedTime();
    
    // 平滑鼠标跟随
    mouse.x += (mouse.targetX - mouse.x) * 0.02;
    mouse.y += (mouse.targetY - mouse.y) * 0.02;
    
    // 更新粒子位置 - 极其轻微的浮动
    const positions = particles.geometry.attributes.position.array;
    const initialPositions = particles.geometry.userData.initialPositions;
    const phases = particles.geometry.userData.phases;
    
    for (let i = 0; i < CONFIG.particleCount; i++) {
      const idx = i * 3;
      const phase = phases[i];
      
      // 非常缓慢的上下浮动
      positions[idx] = initialPositions[idx] + Math.sin(elapsed * 0.15 + phase) * 2;
      positions[idx + 1] = initialPositions[idx + 1] + Math.cos(elapsed * 0.1 + phase) * 1.5;
      positions[idx + 2] = initialPositions[idx + 2] + Math.sin(elapsed * 0.08 + phase * 0.5) * 1;
    }
    particles.geometry.attributes.position.needsUpdate = true;
    
    // 轻微的场景旋转响应鼠标
    scene.rotation.y = mouse.x * 0.03;
    scene.rotation.x = mouse.y * 0.02;
    
    // 更新时间 uniform
    particles.material.uniforms.uTime.value = elapsed;
    
    renderer.render(scene, camera);
    animationId = requestAnimationFrame(animate);
  }

  // 可见性检测
  const heroObserver = new IntersectionObserver((entries) => {
    isVisible = entries[0].isIntersecting;
  }, { threshold: 0.1 });
  heroObserver.observe(heroSection);

  // 启动动画
  animate();

  // API
  window.xiyu3DScene = {
    destroy: function() {
      cancelAnimationFrame(animationId);
      heroObserver.disconnect();
      renderer.dispose();
      scene.clear();
      canvas.remove();
    },
    updateColors: function() {
      const currentColors = getColors();
      const primaryColor = new THREE.Color(currentColors.primary);
      const accentColor = new THREE.Color(currentColors.accent);
      
      const colorArr = particles.geometry.attributes.color.array;
      for (let i = 0; i < CONFIG.particleCount; i++) {
        const color = Math.random() > 0.3 ? primaryColor : accentColor;
        colorArr[i * 3] = color.r;
        colorArr[i * 3 + 1] = color.g;
        colorArr[i * 3 + 2] = color.b;
      }
      particles.geometry.attributes.color.needsUpdate = true;
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
