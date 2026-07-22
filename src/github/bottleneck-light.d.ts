/**
 * bottleneck publishes types only for its main entry ("typings":
 * "bottleneck.d.ts"), not for the light build. The light build is the same
 * class minus the Redis clustering backends (it is what
 * @octokit/plugin-throttling itself imports), so re-export the main types
 * for it. api.ts imports the light build to override the plugin's write
 * limiter without bundling the full build's Redis code.
 */
declare module "bottleneck/light.js" {
  import Bottleneck from "bottleneck";
  export default Bottleneck;
}
