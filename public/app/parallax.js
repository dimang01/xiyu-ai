/**
 * 溪语AI - 鼠标跟随视差效果
 * 全局视差系统 + 卡片 3D 倾斜效果
 */

(function() {
  'use strict';

  // 移动端检测
  const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
  
  // 鼠标位置（归一化到 -1 ~ 1）
  const mouse = {
    x: 0,
    y: 0,
    targetX: 0,
    targetY: 0
  };

  // 视差配置
  const CONFIG = {
    parallaxEase: 0.08,         // 视差缓动速度
    tiltEase: 0.1,              // 倾斜缓动速度
    maxTilt: 12,                // 最大倾斜角度
    glareOpacity: 0.15,         // 光泽最大透明度
    perspective: 1000,          // 3D 透视值
  };

  // ========================
  // 1. 全局视差系统
  // ========================
  
  // 自动为 Hero 区域的关键元素添加视差属性
  function initParallaxElements() {
    const heroSection = document.getElementById('hero');
    if (!heroSection) return;

    // Logo
    const logo = heroSection.querySelector('.logo-float');
    if (logo) {
      logo.setAttribute('data-parallax-depth', '0.12');
      logo.style.willChange = 'transform';
    }

    // 主标题
    const h1 = heroSection.querySelector('h1');
    if (h1) {
      h1.setAttribute('data-parallax-depth', '0.08');
      h1.style.willChange = 'transform';
    }

    // 副标题
    const subtitle = heroSection.querySelector('h1 + p');
    if (subtitle) {
      subtitle.setAttribute('data-parallax-depth', '0.05');
      subtitle.style.willChange = 'transform';
    }

    // 按钮组
    const buttons = heroSection.querySelector('.flex.flex-col');
    if (buttons) {
      buttons.setAttribute('data-parallax-depth', '0.04');
      buttons.style.willChange = 'transform';
    }

    // 数据指标
    const stats = heroSection.querySelector('.grid.grid-cols-3');
    if (stats) {
      stats.setAttribute('data-parallax-depth', '0.03');
      stats.style.willChange = 'transform';
    }

    // Badge
    const badge = heroSection.querySelector('.inline-flex.items-center.gap-2');
    if (badge) {
      badge.setAttribute('data-parallax-depth', '0.06');
      badge.style.willChange = 'transform';
    }
  }

  // 更新所有视差元素
  function updateParallaxElements() {
    const elements = document.querySelectorAll('[data-parallax-depth]');
    
    elements.forEach(el => {
      const depth = parseFloat(el.getAttribute('data-parallax-depth')) || 0.05;
      const moveX = mouse.x * depth * 40;  // 最大移动 40px
      const moveY = mouse.y * depth * 30;  // 最大移动 30px
      
      el.style.transform = `translate3d(${moveX}px, ${moveY}px, 0)`;
    });
  }

  // ========================
  // 2. 卡片 3D 倾斜效果
  // ========================
  
  class TiltCard {
    constructor(element) {
      this.element = element;
      this.glare = null;
      this.bounds = null;
      this.isHovering = false;
      this.tilt = { x: 0, y: 0, targetX: 0, targetY: 0 };
      
      this.init();
    }
    
    init() {
      // 设置 3D 环境
      this.element.style.transformStyle = 'preserve-3d';
      this.element.style.willChange = 'transform';
      this.element.style.transition = 'transform 0.1s ease-out, box-shadow 0.3s ease';
      
      // 创建光泽层
      this.createGlare();
      
      // 绑定事件
      this.element.addEventListener('mouseenter', this.onMouseEnter.bind(this));
      this.element.addEventListener('mousemove', this.onMouseMove.bind(this));
      this.element.addEventListener('mouseleave', this.onMouseLeave.bind(this));
    }
    
    createGlare() {
      this.glare = document.createElement('div');
      this.glare.className = 'tilt-glare';
      this.glare.style.cssText = `
        position: absolute;
        inset: 0;
        border-radius: inherit;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.3s ease;
        background: linear-gradient(
          135deg,
          rgba(255, 255, 255, 0.4) 0%,
          rgba(255, 255, 255, 0) 60%
        );
        z-index: 10;
      `;
      
      // 确保父元素是相对定位
      const currentPosition = getComputedStyle(this.element).position;
      if (currentPosition === 'static') {
        this.element.style.position = 'relative';
      }
      this.element.style.overflow = 'hidden';
      
      this.element.appendChild(this.glare);
    }
    
    onMouseEnter(e) {
      this.isHovering = true;
      this.bounds = this.element.getBoundingClientRect();
      this.glare.style.opacity = CONFIG.glareOpacity;
    }
    
    onMouseMove(e) {
      if (!this.bounds) return;
      
      // 计算鼠标在卡片内的相对位置 (-1 ~ 1)
      const x = (e.clientX - this.bounds.left) / this.bounds.width;
      const y = (e.clientY - this.bounds.top) / this.bounds.height;
      
      // 映射到 -1 ~ 1
      const tiltX = (y - 0.5) * 2;
      const tiltY = (x - 0.5) * -2;
      
      this.tilt.targetX = tiltX * CONFIG.maxTilt;
      this.tilt.targetY = tiltY * CONFIG.maxTilt;
      
      // 更新光泽位置
      const glareX = x * 100;
      const glareY = y * 100;
      this.glare.style.background = `
        radial-gradient(
          circle at ${glareX}% ${glareY}%,
          rgba(255, 255, 255, 0.5) 0%,
          rgba(255, 255, 255, 0) 60%
        )
      `;
    }
    
    onMouseLeave() {
      this.isHovering = false;
      this.tilt.targetX = 0;
      this.tilt.targetY = 0;
      this.glare.style.opacity = 0;
    }
    
    update() {
      // 平滑过渡
      this.tilt.x += (this.tilt.targetX - this.tilt.x) * CONFIG.tiltEase;
      this.tilt.y += (this.tilt.targetY - this.tilt.y) * CONFIG.tiltEase;
      
      // 应用变换
      this.element.style.transform = `
        perspective(${CONFIG.perspective}px)
        rotateX(${this.tilt.x}deg)
        rotateY(${this.tilt.y}deg)
        scale3d(${this.isHovering ? 1.02 : 1}, ${this.isHovering ? 1.02 : 1}, 1)
      `;
    }
  }

  // 收集所有需要倾斜效果的卡片
  const tiltCards = [];
  
  function initTiltCards() {
    // 选择所有功能卡片
    const cardSelectors = [
      '#features article',
      '#metacognition article', 
      '#daily-life article',
      '#relationship article',
      '#memories article',
      '#steps article',
      '#faq details',
    ];
    
    const cards = document.querySelectorAll(cardSelectors.join(', '));
    
    cards.forEach(card => {
      // 跳过已处理的
      if (card.hasAttribute('data-tilt-init')) return;
      card.setAttribute('data-tilt-init', 'true');
      
      tiltCards.push(new TiltCard(card));
    });
  }

  // ========================
  // 3. 动画循环
  // ========================
  
  let animationId;
  
  function animate() {
    // 平滑鼠标追踪
    mouse.x += (mouse.targetX - mouse.x) * CONFIG.parallaxEase;
    mouse.y += (mouse.targetY - mouse.y) * CONFIG.parallaxEase;
    
    // 更新视差元素
    if (!isMobile) {
      updateParallaxElements();
    }
    
    // 更新倾斜卡片
    tiltCards.forEach(card => card.update());
    
    animationId = requestAnimationFrame(animate);
  }

  // ========================
  // 4. 事件监听
  // ========================
  
  // 鼠标移动
  document.addEventListener('mousemove', (e) => {
    mouse.targetX = (e.clientX / window.innerWidth) * 2 - 1;
    mouse.targetY = (e.clientY / window.innerHeight) * 2 - 1;
  });

  // 触摸支持（移动端仍支持卡片倾斜）
  document.addEventListener('touchmove', (e) => {
    if (e.touches.length > 0) {
      mouse.targetX = (e.touches[0].clientX / window.innerWidth) * 2 - 1;
      mouse.targetY = (e.touches[0].clientY / window.innerHeight) * 2 - 1;
    }
  }, { passive: true });

  // ========================
  // 5. 初始化
  // ========================
  
  function init() {
    initParallaxElements();
    initTiltCards();
    animate();
  }

  // DOM 加载完成后初始化
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // 监听 DOM 变化，处理动态添加的元素
  const observer = new MutationObserver(() => {
    initTiltCards();
  });
  
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  // 暴露给全局（可选）
  window.xiyuParallax = {
    destroy: function() {
      cancelAnimationFrame(animationId);
      observer.disconnect();
    },
    refresh: function() {
      initParallaxElements();
      initTiltCards();
    }
  };

})();
