/* 蓝斑凤蝶随身伙伴：跟随、落肩、落到右手食指。
 * 依赖外部传入 THREE（主游戏内联 three / explore 的 module three 都可）。
 * 用法：createButterflyCompanion(THREE, {...}).load()
 */
(function (global) {
  'use strict';

  function createButterflyCompanion(THREE, opts) {
    opts = opts || {};
    var scene = opts.scene;
    var loadGLTF = opts.loadGLTF;
    var url = opts.url || './butterfly.glb';
    var getPlayerRoot = opts.getPlayerRoot || function () { return null; };
    var modelScale = opts.scale || 0.92;
    var debugName = opts.debugName || '__butterfly';

    var group = new THREE.Group();
    group.name = 'butterfly-companion';
    group.visible = false;
    group.scale.setScalar(modelScale);
    group.frustumCulled = false;

    var model = null, mixer = null, actions = {};
    var activeAction = null;
    var ready = false;
    var playerRoot = null;
    var anchors = { arm: null, shoulder: null, index: null, hand: null, leftArm: null, leftFore: null, leftHand: null, leftIndex: null, leftFingers: [] };
    var mode = 'follow';                 // follow / toShoulder / shoulder / toFinger / finger
    var idleTime = 0;
    var shoulderDone = false;
    var fingerDone = false;
    var fingerFrontReady = false;
    var fingerArmStart = null;
    var perchTimer = 0;
    var modeTime = 0;
    var FINGER_FRONT_HOLD = 0.16;   // 在面前停稳后再起手
    var FINGER_RAISE_TIME = 0.90;   // 角色再缓慢抬手
    var pos = new THREE.Vector3();
    var target = new THREE.Vector3();
    var flightDir = new THREE.Vector3();
    var lastDir = new THREE.Vector3(0, 0, -1);
    var quat = new THREE.Quaternion();
    var targetQuat = new THREE.Quaternion();
    var tmpQ = new THREE.Quaternion();
    var tmpV = new THREE.Vector3();
    var tmpV2 = new THREE.Vector3();
    var initialized = false;

    var FLIGHT_LOCAL = new THREE.Vector3(0.58, 1.72, -0.30);
    var FORWARD = new THREE.Vector3(0, 0, -1); // Blender +Y 在 glTF 中是 -Z
    // 两个页面的角色 glTF 前向轴不同：主游戏 -Z，关外角色 +Z（外层 rotation.y=π）。
    var FRONT_Z = (opts && opts.frontZ !== undefined) ? opts.frontZ : -1;

    function ensurePlayer() {
      var current = getPlayerRoot();
      if (current !== playerRoot) {
        playerRoot = current || null;
        anchors.arm = anchors.shoulder = anchors.index = anchors.hand = null;
        anchors.leftArm = anchors.leftFore = anchors.leftHand = anchors.leftIndex = null;
        anchors.leftFingers = [];
        if (playerRoot) findAnchors(playerRoot);
        if (ready && mode !== 'follow' && mode !== 'toShoulder' && mode !== 'toFinger') takeoff();
      }
      return playerRoot;
    }

    function nameMatches(name, suffix) {
      if (!name) return false;
      var n = String(name).replace(/[_:]/g, '');
      return n === suffix || n.endsWith(suffix);
    }

    function findAnchors(root) {
      root.traverse(function (o) {
        if (!o.isBone) return;
        if (!anchors.shoulder && nameMatches(o.name, 'RightShoulder')) anchors.shoulder = o;
        if (!anchors.arm && nameMatches(o.name, 'RightArm')) anchors.arm = o;
        if (!anchors.index && nameMatches(o.name, 'RightHandIndex4')) anchors.index = o;
        if (!anchors.hand && nameMatches(o.name, 'RightHand')) anchors.hand = o;
        if (!anchors.leftArm && nameMatches(o.name, 'LeftArm')) anchors.leftArm = o;
        if (!anchors.leftFore && nameMatches(o.name, 'LeftForeArm')) anchors.leftFore = o;
        if (!anchors.leftHand && nameMatches(o.name, 'LeftHand')) anchors.leftHand = o;
        if (!anchors.leftIndex && nameMatches(o.name, 'LeftHandIndex4')) anchors.leftIndex = o;
        var rawName = String(o.name || '').replace(/[_:]/g, '');
        if (/LeftHand(Index|Middle|Ring|Pinky)[1-4]$/.test(rawName)) anchors.leftFingers.push(o);
      });
    }

    function playerWorldQuat(out) {
      if (playerRoot) return playerRoot.getWorldQuaternion(out);
      return out.identity();
    }

    function localToWorld(local, out) {
      var q = playerWorldQuat(tmpQ);
      out.copy(local).applyQuaternion(q);
      return out;
    }

    function boneTip(bone, frac, out) {
      bone.getWorldPosition(out);
      if (!bone.length) return out;
      var lq = bone.getWorldQuaternion(tmpQ);
      var local = new THREE.Vector3(0, bone.length * frac, 0);
      local.applyQuaternion(lq);
      out.add(local);
      return out;
    }

    function fallbackPlayerPos(out) {
      if (playerRoot) return playerRoot.getWorldPosition(out);
      if (scene && scene.position) return out.copy(scene.position);
      return out.set(0, 0, 0);
    }

    function shoulderAnchor(out) {
      if (anchors.arm) {
        boneTip(anchors.arm, 0.12, out);
      } else if (anchors.shoulder) {
        boneTip(anchors.shoulder, 0.9, out);
      } else {
        fallbackPlayerPos(out);
        localToWorld(new THREE.Vector3(0.24, 1.42, -0.02), tmpV); out.add(tmpV);
        return out;
      }
      localToWorld(new THREE.Vector3(-0.13, 0.075, -0.005), tmpV); out.add(tmpV);
      return out;
    }

    function frontAnchor(out) {
      // 接蝶第一阶段：停在角色正前方、胸口偏上的位置。
      fallbackPlayerPos(out);
      localToWorld(new THREE.Vector3(0, 1.52, 0.58 * FRONT_Z), tmpV); out.add(tmpV);
      return out;
    }

    function fingerAnchor(out) {
      if (anchors.leftIndex) {
        boneTip(anchors.leftIndex, 1.0, out);
        localToWorld(new THREE.Vector3(0, 0.018, -0.012), tmpV); out.add(tmpV);
      } else if (anchors.leftHand) {
        boneTip(anchors.leftHand, 0.9, out);
        localToWorld(new THREE.Vector3(0.015, 0.045, 0.02), tmpV); out.add(tmpV);
      } else {
        fallbackPlayerPos(out);
        localToWorld(new THREE.Vector3(-0.28, 1.18, 0.10), tmpV); out.add(tmpV);
      }
      return out;
    }

    function setBoneDir(bone, dir, amount) {
      if (!bone || dir.lengthSq() < 0.000001) return;
      dir.normalize();
      var qWorld = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      var parentQ = bone.parent ? bone.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
      var localQ = parentQ.invert().multiply(qWorld);
      bone.quaternion.slerp(localQ, amount);
      bone.updateMatrixWorld(true);
    }

    // 待机接蝶：把左手抬到身前偏左，食指朝上，蝴蝶落在食指指尖。
    // 每帧在玩家 mixer 之后覆盖左臂姿态；起飞后 mixer 会自动回到 Idle。
    function applyReceivePose(amount) {
      if (!anchors.leftArm || !anchors.leftFore || !anchors.leftHand) return;
      if (amount <= 0.001) return;
      var rootQ = playerWorldQuat(new THREE.Quaternion());
      var up = new THREE.Vector3(0, 1, 0);
      var shoulder = anchors.leftArm.getWorldPosition(new THREE.Vector3());
      var elbowTarget = shoulder.clone().add(new THREE.Vector3(0.16, -0.12, 0.10).applyQuaternion(rootQ));
      var wristTarget = elbowTarget.clone().add(new THREE.Vector3(0.13, 0.18, 0.10).applyQuaternion(rootQ));
      var handTarget = wristTarget.clone().add(new THREE.Vector3(0.03, 0.07, 0.04).applyQuaternion(rootQ));
      setBoneDir(anchors.leftArm, elbowTarget.sub(shoulder), amount);
      var foreHead = anchors.leftFore.getWorldPosition(new THREE.Vector3());
      setBoneDir(anchors.leftFore, wristTarget.sub(foreHead), amount);
      var handHead = anchors.leftHand.getWorldPosition(new THREE.Vector3());
      setBoneDir(anchors.leftHand, handTarget.sub(handHead), amount);
      // 主角 Idle 的左手是握拳；接蝶时把手指展开，蝴蝶才有指尖可落。
      if (anchors.leftFingers.length) {
        var flat = new THREE.Quaternion();
        anchors.leftFingers.forEach(function (b) {
          b.quaternion.slerp(flat, amount);
          b.updateMatrixWorld(true);
        });
      }
    }

    function desiredFlight(out) {
      fallbackPlayerPos(out);
      var q = playerWorldQuat(tmpQ);
      var bob = Math.sin(performance.now() / 1000 * 2.4) * 0.035;
      var local = tmpV.copy(FLIGHT_LOCAL);
      local.x += Math.sin(performance.now() / 1000 * 1.7) * 0.035;
      local.y += bob;
      local.applyQuaternion(q);
      out.add(local);
      return out;
    }

    function setAction(name) {
      if (!actions[name]) return;
      var next = actions[name];
      if (next === activeAction) return;
      next.reset();
      next.enabled = true;
      next.setEffectiveTimeScale(1);
      next.setEffectiveWeight(1);
      next.setLoop(THREE.LoopRepeat, Infinity);
      next.clampWhenFinished = false;
      if (activeAction) {
        next.crossFadeFrom(activeAction, 0.22, false);
      } else {
        next.fadeIn(0.22);
      }
      next.play();
      activeAction = next;
    }

    function placeInitially() {
      if (!ready) return;
      if (!playerRoot) ensurePlayer();
      if (!playerRoot) return;
      desiredFlight(pos);
      group.position.copy(pos);
      quat.setFromUnitVectors(FORWARD, new THREE.Vector3(0, 0, 1));
      group.quaternion.copy(quat);
      group.visible = true;
      initialized = true;
    }

    function takeoff() {
      mode = 'follow';
      modeTime = 0;
      setAction('Fly');
      flightDir.set(0, 0, 0);
    }

    function startPerch(kind) {
      mode = kind === 'shoulder' ? 'toShoulder' : 'toFinger';
      modeTime = 0;
      fingerFrontReady = false;
      fingerArmStart = null;
      setAction('Fly');
    }

    function beginLanding(kind) {
      mode = kind;
      modeTime = 0;
      perchTimer = 0;
      setAction('Perch');
    }

    function finishPerch() {
      if (mode === 'shoulder') {
        // 肩上停一会儿后，如果玩家还闲着，偶尔会再飞到手指上。
        if (idleTime > 5.8 && !fingerDone && Math.random() < 0.72) {
          fingerDone = true;
          startPerch('finger');
          return;
        }
      }
      takeoff();
    }

    function stepTowards(targetPos, dt, rate) {
      if (!initialized) {
        pos.copy(targetPos);
        initialized = true;
      }
      var dist = pos.distanceTo(targetPos);
      if (dist > 10) {
        pos.copy(targetPos);
      } else {
        var r = rate;
        if (dist > 3.5) r = Math.max(r, 7.0);
        var t = 1 - Math.exp(-r * dt);
        pos.lerp(targetPos, t);
      }
      group.position.copy(pos);
    }

    function faceFlight(dt) {
      flightDir.copy(target).sub(pos);
      if (flightDir.lengthSq() > 0.0004) {
        flightDir.normalize();
        lastDir.lerp(flightDir, 1 - Math.exp(-5 * dt)).normalize();
        targetQuat.setFromUnitVectors(FORWARD, lastDir);
        quat.slerp(targetQuat, 1 - Math.exp(-7 * dt));
      }
      group.quaternion.copy(quat);
    }

    function facePerch(playerQ, dt) {
      // 蝴蝶头朝玩家面朝的方向；模型局部前方是 -Z，玩家局部前方是 +Z。
      targetQuat.copy(playerQ).multiply(tmpQ.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
      quat.slerp(targetQuat, 1 - Math.exp(-9 * dt));
      group.quaternion.copy(quat);
    }

    function onLoad(gltf) {
      model = gltf.scene || gltf.scenes[0];
      model.name = 'butterfly-model';
      model.traverse(function (o) {
        if (!o.isMesh) return;
        o.castShadow = false;
        o.receiveShadow = false;
        o.frustumCulled = false;
        o.renderOrder = 1;
        var mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach(function (m) {
          if (!m) return;
          // Blender 导出的是 BLEND，游戏里用 alphaTest 更稳定，不会和角色/草木互相排序。
          if (m.map) {
            m.map.colorSpace = THREE.SRGBColorSpace;
            m.map.needsUpdate = true;
          }
          m.transparent = false;
          m.alphaTest = Math.max(m.alphaTest || 0, 0.35);
          m.depthWrite = true;
          m.side = THREE.DoubleSide;
          if (/Wing/i.test(m.name || '')) {
            m.emissive = new THREE.Color(0x2b78a9);
            m.emissiveIntensity = 0.30;
            m.roughness = Math.min(m.roughness == null ? 0.55 : m.roughness, 0.55);
          }
          m.needsUpdate = true;
        });
      });
      group.add(model);
      if (!group.parent && scene) scene.add(group);

      mixer = new THREE.AnimationMixer(model);
      (gltf.animations || []).forEach(function (clip) {
        actions[clip.name] = mixer.clipAction(clip);
      });
      setAction('Fly');
      ready = true;
      ensurePlayer();
      placeInitially();
      console.log('[butterfly] ready, bones:', ['arm','shoulder','index','hand','leftArm','leftFore','leftHand','leftIndex'].filter(function (k) { return !!anchors[k]; }).join(',') || 'fallback');
    }

    function load() {
      if (!loadGLTF) return Promise.reject(new Error('missing loadGLTF'));
      return loadGLTF(url).then(onLoad).catch(function (err) {
        console.warn('[butterfly] load failed', err);
        throw err;
      });
    }

    function fingerRaiseProgress() {
      if (mode !== 'toFinger' || !fingerFrontReady || fingerArmStart === null) return 0;
      var t = Math.min(1, Math.max(0, (modeTime - fingerArmStart) / FINGER_RAISE_TIME));
      return t * t * (3 - 2 * t);
    }

    function update(dt, ctx) {
      if (!ready) return;
      ctx = ctx || {};
      dt = Math.min(Math.max(dt || 0, 0), 0.05);
      ensurePlayer();
      if (!playerRoot) return;

      mixer.update(dt);
      if (!initialized) placeInitially();
      if (!initialized) return;

      var isIdle = !!ctx.isIdle;
      var canPerch = !!ctx.canPerch;
      var moving = !!ctx.moving;

      // 接蝶手势：先让蝴蝶在正前方停住，再接管左臂缓慢抬起；其它状态交给玩家动画。
      if (mode === 'toFinger' || mode === 'finger') {
        applyReceivePose(mode === 'finger' ? 1 : fingerRaiseProgress());
      }

      if (mode === 'follow' || mode === 'toShoulder' || mode === 'toFinger') {
        if (isIdle) {
          idleTime += dt;
        } else {
          idleTime = 0;
          shoulderDone = false;
          fingerDone = false;
        }
      }

      if (moving && (mode === 'shoulder' || mode === 'toShoulder')) takeoff();
      if (moving && (mode === 'finger' || mode === 'toFinger')) takeoff();

      if (mode === 'follow') {
        desiredFlight(target);
        var dist = pos.distanceTo(target);
        stepTowards(target, dt, 5.2);
        faceFlight(dt);

        if (canPerch && isIdle) {
          if (idleTime > 2.8 && !shoulderDone && !fingerDone) {
            shoulderDone = true;
            if (Math.random() < 0.82) startPerch('shoulder');
          }
          if (mode === 'follow' && idleTime > 8.0 && !fingerDone) {
            fingerDone = true;
            startPerch('finger');
          }
        }
      } else if (mode === 'toShoulder') {
        shoulderAnchor(target);
        stepTowards(target, dt, 8.0);
        faceFlight(dt);
        modeTime += dt;
        if (pos.distanceTo(target) < 0.045 || modeTime > 3.2) {
          beginLanding('shoulder');
          shoulderDone = true;
        }
      } else if (mode === 'shoulder') {
        shoulderAnchor(target);
        stepTowards(target, dt, 12.0);
        facePerch(playerWorldQuat(tmpQ), dt);
        perchTimer += dt;
        modeTime += dt;
        if (perchTimer > 3.2) finishPerch();
      } else if (mode === 'toFinger') {
        modeTime += dt;
        if (!fingerFrontReady) {
          // 第一阶段：先飞到角色面前停住，此时左手仍保持 Idle。
          frontAnchor(target);
          stepTowards(target, dt, 6.0);
          faceFlight(dt);
          if (pos.distanceTo(target) < 0.11) {
            fingerFrontReady = true;
            fingerArmStart = modeTime + FINGER_FRONT_HOLD;
          } else if (modeTime > 1.25) {
            // 兜底：就算蝴蝶绕路太慢，也不能一直举着手等。
            fingerFrontReady = true;
            fingerArmStart = modeTime + FINGER_FRONT_HOLD;
          }
        } else {
          // 第二阶段：蝴蝶先在面前悬停，角色慢慢把手抬到它下方；
          // 手抬到接近最终姿势后才让蝴蝶落到食指尖，避免“手还没起，蝶先下坠”。
          var raiseT = fingerRaiseProgress();
          if (raiseT < 0.72) {
            frontAnchor(target);
          } else {
            fingerAnchor(target);
          }
          stepTowards(target, dt, 5.0);
          faceFlight(dt);
          if (raiseT >= 0.94 && pos.distanceTo(target) < 0.09) {
            beginLanding('finger');
            fingerDone = true;
          } else if (modeTime > 4.2) {
            beginLanding('finger');
            fingerDone = true;
          }
        }
      } else if (mode === 'finger') {
        fingerAnchor(target);
        stepTowards(target, dt, 12.0);
        facePerch(playerWorldQuat(tmpQ), dt);
        perchTimer += dt;
        modeTime += dt;
        if (perchTimer > 4.8) takeoff();
      }
    }

    function debug() {
      return {
        ready: ready,
        mode: mode,
        idleTime: idleTime,
        modeTime: modeTime,
        perchTimer: perchTimer,
        frontReady: fingerFrontReady,
        armStart: fingerArmStart,
        raise: mode === 'finger' ? 1 : +fingerRaiseProgress().toFixed(3),
        position: pos.toArray(),
        player: playerRoot ? playerRoot.name : null,
        anchors: ['arm','shoulder','index','hand','leftArm','leftFore','leftHand','leftIndex'].filter(function (k) { return !!anchors[k]; }),
        hasModel: !!model,
        action: activeAction ? activeAction.getClip().name : null
      };
    }

    function force(kind) {
      if (!ready) return false;
      if (kind === 'shoulder') startPerch('shoulder');
      else if (kind === 'finger') startPerch('finger');
      else if (kind === 'follow') takeoff();
      return true;
    }

    var api = {
      load: load,
      update: update,
      debug: debug,
      force: force,
      setPlayerRoot: function (root) {
        playerRoot = root || null;
        anchors.arm = anchors.shoulder = anchors.index = anchors.hand = null;
        anchors.leftArm = anchors.leftFore = anchors.leftHand = anchors.leftIndex = null;
        anchors.leftFingers = [];
        if (playerRoot) findAnchors(playerRoot);
        takeoff();
      },
      get group() { return group; },
      get model() { return model; },
      get ready() { return ready; },
      get mode() { return mode; }
    };
    if (global) global[debugName] = api;
    return api;
  }

  global.createButterflyCompanion = createButterflyCompanion;
})(typeof window !== 'undefined' ? window : globalThis);
