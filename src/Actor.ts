// A modular skeletal actor (the farmer). Parts are assembled from the rig layout
// (offset/pivot/z per part) and animated by swapping arm poses + a walk bob, plus
// a "work" animation (hoeing) used for tilling / planting / harvesting.
//
// Coordinate conversion, rig (cocos2d, Y-up) -> Pixi (Y-down):
//   position: (offsetX, -offsetY)      offsetY is height above the feet origin
//   anchor:   (pivotX, 1 - pivotY)     cocos anchorY is bottom-up
// The container origin (0,0) is the character's ground point; we place that on a
// tile center. sortableChildren + zIndex reproduce the game's part layering.
import { Container, Sprite } from "pixi.js";
import { GameAssets } from "./assets";

const STEP_PERIOD = 0.26; // seconds per arm-swing half-cycle while walking
const ARM_SWING = 0.5; // radians the arms rock fore/aft while walking
const LEG_SWING = 0.32; // radians the legs rock while walking
const WORK_SPEED = 8.5; // hoe-chop angular speed while working

export class Actor {
  readonly container = new Container();
  private body!: Sprite;
  private head!: Sprite;
  private backArm!: Sprite;
  private frontArm!: Sprite;
  private bootBack!: Sprite;
  private bootFront!: Sprite;
  private plough!: Sprite;

  private bodyBaseY = 0;
  private headBaseY = 0;
  private bootBackBaseY = 0;
  private bootFrontBaseY = 0;
  private ploughBaseX = 0;
  private ploughBaseY = 0;

  private moving = false;
  private working = false;
  private workSpeed = 1; // multiplier on the hoe-chop rate (2 = twice as fast)
  private facing = 1; // +1 right, -1 left
  private phase = 0; // walk clock
  private workPhase = 0; // work clock

  constructor(private assets: GameAssets) {
    this.container.sortableChildren = true;
    // ZF2 renders no ground shadow for characters (verified in the binary — actors
    // are just body-part attachments); the farmer casts none, matching the original.
    this.backArm = this.part("male_arm1.png");
    this.frontArm = this.part("male_arm2.png");
    this.body = this.part("malebody1.png");
    this.bootBack = this.part("boot_back.png");
    this.bootFront = this.part("boot_front.png");
    this.head = this.part("malehead1.png");
    // The hoe sits in the front hand (z between body and front arm), hidden until
    // the farmer works a plot.
    this.plough = this.part("plough.png");
    this.plough.position.set(15, -22);
    this.plough.zIndex = 5;
    this.plough.visible = false;

    this.bodyBaseY = this.body.y;
    this.headBaseY = this.head.y;
    this.bootBackBaseY = this.bootBack.y;
    this.bootFrontBaseY = this.bootFront.y;
    this.ploughBaseX = this.plough.x;
    this.ploughBaseY = this.plough.y;
  }

  private part(file: string): Sprite {
    const layout = this.assets.rig[file];
    const sp = new Sprite(this.assets.player[file]);
    sp.anchor.set(layout.pivotX, 1 - layout.pivotY);
    sp.position.set(layout.offsetX, -layout.offsetY);
    sp.zIndex = layout.z;
    this.container.addChild(sp);
    return sp;
  }

  setMoving(m: boolean) {
    if (m) this.working = false;
    this.moving = m;
    if (!m) this.resetPose();
  }

  // Enter/leave the hoeing animation (used at the end of a walk-to-plot job).
  // `speed` scales the chop rate (2 = twice as fast, for fruit-tree harvesting).
  setWorking(w: boolean, speed = 1) {
    if (w) this.moving = false;
    this.working = w;
    this.workSpeed = speed;
    this.workPhase = 0;
    this.plough.visible = w;
    if (!w) this.resetPose();
  }

  // Face toward a world-space movement delta (dx from iso projection).
  // The source art faces LEFT at scale.x = +1, so moving right (dx > 0) must
  // mirror it (scale.x = -1) to face right.
  setFacingFromDelta(dx: number) {
    if (dx > 0.01) this.facing = -1;
    else if (dx < -0.01) this.facing = 1;
    this.container.scale.x = this.facing;
  }

  private resetPose() {
    this.backArm.texture = this.assets.player["male_arm1.png"];
    this.frontArm.texture = this.assets.player["male_arm2.png"];
    this.body.y = this.bodyBaseY;
    this.body.rotation = 0;
    this.head.y = this.headBaseY;
    this.head.rotation = 0;
    this.backArm.rotation = 0;
    this.frontArm.rotation = 0;
    this.bootBack.y = this.bootBackBaseY;
    this.bootBack.rotation = 0;
    this.bootFront.y = this.bootFrontBaseY;
    this.bootFront.rotation = 0;
    this.plough.position.set(this.ploughBaseX, this.ploughBaseY);
    this.plough.rotation = 0;
  }

  update(dt: number) {
    if (this.working) return this.workAnim(dt);
    if (this.moving) return this.walkAnim(dt);
  }

  private walkAnim(dt: number) {
    this.phase += dt;
    // Arm pose A/B swap on each half-cycle for a bit of shape change...
    const poseB = Math.floor(this.phase / STEP_PERIOD) % 2 === 1;
    this.backArm.texture =
      this.assets.player[poseB ? "male_arm3.png" : "male_arm1.png"];
    this.frontArm.texture =
      this.assets.player[poseB ? "male_arm4.png" : "male_arm2.png"];
    // ...plus a continuous fore/aft swing on arms and legs (the "rotaty" motion).
    const t = (this.phase / STEP_PERIOD) * Math.PI;
    const swing = Math.sin(t);
    const bob = swing * 1.5;
    this.body.y = this.bodyBaseY - Math.abs(bob);
    this.head.y = this.headBaseY - Math.abs(bob);
    this.backArm.rotation = swing * ARM_SWING;
    this.frontArm.rotation = -swing * ARM_SWING;
    // Legs counter-swing + lift on the forward stroke.
    this.bootBack.rotation = -swing * LEG_SWING;
    this.bootFront.rotation = swing * LEG_SWING;
    this.bootBack.y = this.bootBackBaseY - Math.max(0, bob);
    this.bootFront.y = this.bootFrontBaseY - Math.max(0, -bob);
  }

  // Hoeing: head tilted forward, BOTH arms held out FORWARD roughly parallel to the
  // ground (~4 degrees below horizontal), gripping the hoe which hangs from the
  // hands and only bobs a little. Same cycle for till / plant / harvest.
  private workAnim(dt: number) {
    this.workPhase += dt;
    this.frontArm.texture = this.assets.player["male_arm4.png"];
    this.backArm.texture = this.assets.player["male_arm3.png"];
    const chop = Math.sin(this.workPhase * WORK_SPEED * this.workSpeed); // -1..1
    // Head leans forward (toward the facing/work direction; negative = toward the
    // art's front, which the container scale mirrors correctly) with a slight nod.
    this.head.rotation = -0.18 - Math.abs(chop) * 0.04;
    this.head.y = this.headBaseY + 1;
    // Both arms reach forward, ~parallel to the ground (rest pose points down, so
    // +pi/2 swings them to horizontal-forward; 1.5 rad leaves them ~4deg below).
    const arm = 1.5 + chop * 0.05;
    this.frontArm.rotation = arm;
    this.backArm.rotation = arm;
    // Hoe gripped between the two forward hands (~x -17..-35), angled down to the
    // dirt ahead; small movement only.
    this.plough.x = -22;
    this.plough.y = -8 + Math.max(0, chop) * 1.5;
    this.plough.rotation = 0.28 - chop * 0.1;
    // Body bobs a touch so he "moves a bit".
    this.body.rotation = chop * 0.02;
    this.body.y = this.bodyBaseY + Math.abs(chop) * 1.2;
  }
}
