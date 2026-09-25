import type { AppMachineSettings } from '../../shared/types';

export const DEFAULT_APP_MACHINE_SETTINGS:AppMachineSettings={
  schemaVersion:1,endpointPolicy:'loopback-only',
  ffmpeg:{path:process.env.CINEFORGE_FFMPEG||'ffmpeg',ffprobePath:process.env.CINEFORGE_FFPROBE||'ffprobe',preferredH264Encoder:'h264_nvenc'},
  wangp:{executionMode:'native',rootPath:process.env.CINEFORGE_WANGP_ROOT||'',pythonPath:process.env.CINEFORGE_PYTHON||'python',entrypoint:'wgp.py',profile:4,attention:'auto',dryRunBeforeRender:true,docker:{command:process.env.CINEFORGE_DOCKER||'docker',image:process.env.CINEFORGE_WANGP_IMAGE||'',projectMount:'/workspace/project',wangpMount:'/workspace/Wan2GP'}},
  comfy:{url:process.env.CINEFORGE_COMFY_URL||'http://127.0.0.1:8188',inputDir:process.env.CINEFORGE_COMFY_INPUT||'',dedicatedInstance:true},
  director:{baseUrl:process.env.CINEFORGE_DIRECTOR_URL||'http://127.0.0.1:11434/v1',model:process.env.CINEFORGE_DIRECTOR_MODEL||'',temperature:.3},
  diagnostics:{persistVerboseLogs:false}
};
