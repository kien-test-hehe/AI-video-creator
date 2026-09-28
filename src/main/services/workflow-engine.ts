import { readJsonFileLimited } from './json-file';
import type { WorkflowBinding, WorkflowBindingKey, WorkflowProfile } from '../../shared/types';
import { assertSafeObjectKey } from '../../shared/safe-object';
import { WORKFLOW_BINDING_LIMIT } from '../../shared/workflow-limits';

export type ApiWorkflow = Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } }>;

export interface WorkflowValues {
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  resolution?: string;
  frames: number;
  fps: number;
  steps?: number;
  cfg?: number;
  seed: number;
  startImage?: string;
  endImage?: string;
  locationImage?: string;
  characterImage1?: string;
  characterImage2?: string;
  characterImage3?: string;
  characterImage4?: string;
  propImage1?: string;
  propImage2?: string;
  referenceImages?: string[];
  referenceImage1?: string;
  referenceImage2?: string;
  referenceImage3?: string;
  referenceImage4?: string;
  inputAudio?: string;
  inputVideo?: string;
  filenamePrefix: string;
}

export function detectWorkflowFormat(value: any): 'api' | 'ui' {
  if (value && Array.isArray(value.nodes) && Array.isArray(value.links)) return 'ui';
  if (value && typeof value === 'object' && Object.values(value).some((n: any) => n?.class_type && n?.inputs)) return 'api';
  throw new Error('Unrecognized ComfyUI workflow JSON format.');
}

export async function readWorkflow(path: string): Promise<any> {
  return readJsonFileLimited(path,'ComfyUI workflow JSON');
}

function parseFiniteNumberTransform(value:unknown):number{const parsed=typeof value==='number'?value:Number(typeof value==='string'?value.trim():value);if(!Number.isFinite(parsed))throw new Error(`Cannot transform value to a finite number safely: ${String(value)}`);return parsed;}
function parseBooleanTransform(value:unknown):boolean{
  if(typeof value==='boolean')return value;
  if(typeof value==='number'){if(value===1)return true;if(value===0)return false;}
  if(typeof value==='string'){
    const normalized=value.trim().toLowerCase();
    if(['true','1','yes','on'].includes(normalized))return true;
    if(['false','0','no','off',''].includes(normalized))return false;
  }
  throw new Error(`Cannot transform value to boolean safely: ${String(value)}`);
}
function transformValue(value: unknown, transform: WorkflowBinding['transform']): unknown {
  switch (transform) {
    case 'integer': return Math.round(parseFiniteNumberTransform(value));
    case 'float': return parseFiniteNumberTransform(value);
    case 'boolean': return parseBooleanTransform(value);
    case 'string': return value == null ? '' : String(value);
    default: return value;
  }
}

function matchesNode(id: string, node: ApiWorkflow[string], binding: WorkflowBinding): boolean {
  const selector = binding.selector;
  if (!selector) return false;
  if (selector.nodeId && id !== selector.nodeId) return false;
  if (selector.classType && node.class_type !== selector.classType) return false;
  if (selector.titleIncludes) {
    const title = node._meta?.title || '';
    if (!title.toLowerCase().includes(selector.titleIncludes.toLowerCase())) return false;
  }
  return Boolean(selector.nodeId || selector.classType || selector.titleIncludes);
}

export function applyBindings(workflow: ApiWorkflow, bindings: WorkflowBinding[], values: WorkflowValues): ApiWorkflow {
  const output = structuredClone(workflow);
  for (const binding of bindings) {
    const value = values[binding.key];
    if (value === undefined || value === null || value === '') {
      if (binding.required) throw new Error(`Required workflow binding is missing: ${binding.key}`);
      continue;
    }
    const matches = Object.entries(output).filter(([id, node]) => matchesNode(id, node, binding));
    if (matches.length === 0) {
      if (binding.required) throw new Error(`No workflow node matched required binding: ${binding.key}`);
      continue;
    }
    if (!binding.input) {
      if (binding.required) throw new Error(`Required ComfyUI binding has no input: ${binding.key}`);
      continue;
    }
    const input=assertSafeObjectKey(binding.input,'ComfyUI binding input');
    for (const [, node] of matches) node.inputs[input] = transformValue(value, binding.transform);
  }
  return output;
}

const INPUT_NAME_HINTS: Record<WorkflowBindingKey, string[]> = {
  prompt: ['text', 'prompt', 'positive_prompt', 'positive'],
  negativePrompt: ['negative_prompt', 'negative', 'text'],
  width: ['width'],
  height: ['height'],
  resolution: ['resolution', 'size'],
  frames: ['length', 'frames', 'frame_count', 'num_frames', 'video_length'],
  fps: ['fps', 'frame_rate', 'force_fps'],
  steps: ['steps', 'num_steps', 'num_inference_steps'],
  cfg: ['cfg', 'guidance', 'guidance_scale'],
  seed: ['seed', 'noise_seed'],
  startImage: ['image', 'start_image', 'first_frame'],
  endImage: ['end_image', 'last_image', 'last_frame'],
  locationImage: ['location_image', 'environment_image', 'scene_image'],
  characterImage1: ['character_image_1', 'character1', 'person_image_1'],
  characterImage2: ['character_image_2', 'character2', 'person_image_2'],
  characterImage3: ['character_image_3', 'character3', 'person_image_3'],
  characterImage4: ['character_image_4', 'character4', 'person_image_4'],
  propImage1: ['prop_image_1', 'prop1', 'object_image_1'],
  propImage2: ['prop_image_2', 'prop2', 'object_image_2'],
  referenceImages: ['image_refs', 'reference_images'],
  referenceImage1: ['reference_image_1', 'reference1', 'ref_image_1'],
  referenceImage2: ['reference_image_2', 'reference2', 'ref_image_2'],
  referenceImage3: ['reference_image_3', 'reference3', 'ref_image_3'],
  referenceImage4: ['reference_image_4', 'reference4', 'ref_image_4'],
  inputAudio: ['audio', 'input_audio', 'audio_guide'],
  inputVideo: ['video', 'input_video', 'video_guide'],
  filenamePrefix: ['filename_prefix', 'filename', 'prefix']
};

export function suggestBindings(workflow: ApiWorkflow): WorkflowBinding[] {
  const suggestions: WorkflowBinding[] = [];
  const used = new Set<string>();
  for (const [id, node] of Object.entries(workflow)) {
    const title = node._meta?.title || '';
    for (const [input, currentValue] of Object.entries(node.inputs || {})) {
      if (Array.isArray(currentValue)) continue;
      for (const [key, hints] of Object.entries(INPUT_NAME_HINTS) as [WorkflowBindingKey, string[]][]) {
        if (used.has(key) && !['prompt', 'negativePrompt'].includes(key)) continue;
        const lower = input.toLowerCase();
        const titleLower = title.toLowerCase();
        if (!hints.some(h => lower === h || lower.includes(h))) continue;
        if (key === 'prompt' && (/negative/.test(titleLower) || /negative/.test(lower))) continue;
        if (key === 'negativePrompt' && !/negative/.test(titleLower) && !/negative/.test(lower) && lower === 'text') continue;
        if(suggestions.length>=WORKFLOW_BINDING_LIMIT)throw new Error(`Suggested workflow bindings exceed the ${WORKFLOW_BINDING_LIMIT}-binding project safety limit. Simplify the workflow or configure bindings manually.`);
        if(suggestions.length>=WORKFLOW_BINDING_LIMIT)throw new Error(`Suggested workflow bindings exceed the ${WORKFLOW_BINDING_LIMIT}-binding project safety limit. Simplify the workflow or configure bindings manually.`);
        suggestions.push({
          key,
          selector: { nodeId: id, classType: node.class_type, ...(title ? { titleIncludes: title } : {}) },
          input,
          transform: typeof currentValue === 'number' ? (Number.isInteger(currentValue) ? 'integer' : 'float') : 'identity',
          required: ['prompt', 'seed'].includes(key)
        });
        used.add(key);
        break;
      }
    }
  }
  return suggestions;
}

export async function inspectWorkflow(path: string): Promise<{ format: 'api' | 'ui'; suggestedBindings: WorkflowBinding[] }> {
  const workflow = await readWorkflow(path);
  const format = detectWorkflowFormat(workflow);
  if (format === 'ui') return { format, suggestedBindings: [] };
  return { format, suggestedBindings: suggestBindings(workflow as ApiWorkflow) };
}

export async function validateComfyNodeAvailability(profile:WorkflowProfile,objectInfo:unknown):Promise<string[]>{
  const workflow=await readWorkflow(profile.workflowPath);
  if(detectWorkflowFormat(workflow)!=='api')return[];
  if(!objectInfo||typeof objectInfo!=='object'||Array.isArray(objectInfo))return['ComfyUI object_info returned an invalid node catalog.'];
  const available=new Set(Object.keys(objectInfo as Record<string,unknown>));
  const missing=[...new Set(Object.values(workflow as ApiWorkflow).map(node=>node.class_type).filter(classType=>!available.has(classType)))].sort();
  return missing.map(classType=>`ComfyUI node class is unavailable in the connected runtime: ${classType}`);
}

export async function validateProfileBindings(profile: WorkflowProfile): Promise<string[]> {
  const workflow = await readWorkflow(profile.workflowPath);
  if (detectWorkflowFormat(workflow) !== 'api') return ['Workflow is not in API format.'];
  const api = workflow as ApiWorkflow;
  const errors: string[] = [];
  if((profile.purpose??'video')==='video'||profile.purpose==='image'){
    if(!profile.bindings.some(binding=>binding.key==='prompt'))errors.push('prompt: no prompt binding configured.');
    if(!profile.bindings.some(binding=>binding.key==='seed'))errors.push('seed: no seed binding configured; deterministic shot retries require a seed binding.');
  }
  for (const binding of profile.bindings) {
    const count = Object.entries(api).filter(([id,node]) => matchesNode(id,node,binding)).length;
    if (count === 0) errors.push(`${binding.key}: selector matches no node.`);
    if (count > 1 && binding.selector?.nodeId == null) errors.push(`${binding.key}: selector matches ${count} nodes; use a nodeId for deterministic binding.`);
    if (count > 0) {
      const matched = Object.entries(api).filter(([id,node]) => matchesNode(id,node,binding));
      if (!binding.input) errors.push(`${binding.key}: missing input name.`);
      else if (matched.some(([,node]) => !Object.prototype.hasOwnProperty.call(node.inputs,binding.input!))) errors.push(`${binding.key}: input “${binding.input}” is not present on every matched node.`);
    }
  }
  return errors;
}

export async function compileProfile(profile: WorkflowProfile, values: WorkflowValues): Promise<ApiWorkflow> {
  const workflow = await readWorkflow(profile.workflowPath);
  const format = detectWorkflowFormat(workflow);
  if (format !== 'api') {
    throw new Error('This profile uses UI workflow JSON. Export it from ComfyUI using "Save (API Format)" before rendering.');
  }
  return applyBindings(workflow as ApiWorkflow, profile.bindings, values);
}

export interface UiWorkflowNode {
  id: number | string;
  type: string;
  title?: string;
  mode?: number;
  inputs?: Array<{ name: string; link?: number | string | null; widget?: unknown }>;
  outputs?: Array<{ name?: string; links?: Array<number | string> | null }>;
  widgets_values?: unknown[];
}

export interface UiWorkflow {
  nodes: UiWorkflowNode[];
  links: Array<any>;
}

function normalizeLink(link: any): { id: string; originId: string; originSlot: number; targetId: string; targetSlot: number } | null {
  let id:unknown,originId:unknown,originSlot:unknown,targetId:unknown,targetSlot:unknown;
  if(Array.isArray(link)&&link.length>=5)[id,originId,originSlot,targetId,targetSlot]=link;
  else if(link&&typeof link==='object'){
    id=link.id??link[0];originId=link.origin_id??link.originId??link[1];originSlot=link.origin_slot??link.originSlot??link[2];
    targetId=link.target_id??link.targetId??link[3];targetSlot=link.target_slot??link.targetSlot??link[4];
  }else return null;
  const originSlotNumber=Number(originSlot),targetSlotNumber=Number(targetSlot);
  if(id==null||originId==null||targetId==null||String(id)===''||String(originId)===''||String(targetId)==='')return null;
  if(!Number.isInteger(originSlotNumber)||originSlotNumber<0||!Number.isInteger(targetSlotNumber)||targetSlotNumber<0)return null;
  return{id:String(id),originId:String(originId),originSlot:originSlotNumber,targetId:String(targetId),targetSlot:targetSlotNumber};
}

/**
 * Converts standard ComfyUI UI workflow JSON to the server /prompt shape.
 * It intentionally targets normal core/custom nodes. Subgraphs and exotic
 * frontend-only widgets can still require an API-format export from ComfyUI.
 */
export function uiWorkflowToApi(ui: UiWorkflow, objectInfo: Record<string, any>): { workflow: ApiWorkflow; warnings: string[]; requiresApiExport: boolean } {
  const warnings: string[] = [];
  let requiresApiExport = false;
  const result=Object.create(null) as ApiWorkflow;
  const activeNodes = new Map<string, UiWorkflowNode>(),seenNodeIds=new Set<string>();
  for (const rawNode of ui.nodes || []) {
    if(!rawNode||typeof rawNode!=='object'||Array.isArray(rawNode)){requiresApiExport=true;warnings.push('Workflow contains a malformed node record. Export Save (API Format).');continue;}
    const node=rawNode as UiWorkflowNode,rawId=node.id;
    const nodeId=(typeof rawId==='string'||typeof rawId==='number')?String(rawId):'';
    if(!nodeId){requiresApiExport=true;warnings.push('Workflow contains a node with a missing/invalid id. Export Save (API Format).');continue;}
    if(seenNodeIds.has(nodeId)){requiresApiExport=true;warnings.push(`Workflow contains duplicate node id ${nodeId}. Automatic conversion is unsafe; export Save (API Format).`);continue;}
    seenNodeIds.add(nodeId);
    if(typeof node.type!=='string'||!node.type.trim()){requiresApiExport=true;warnings.push(`Node ${nodeId} has a missing/invalid type. Export Save (API Format).`);continue;}
    if(node.mode!=null&&(!Number.isInteger(node.mode)||node.mode<0)){requiresApiExport=true;warnings.push(`Node ${nodeId} has an invalid mode. Export Save (API Format).`);continue;}
    if(node.inputs!=null&&!Array.isArray(node.inputs)){requiresApiExport=true;warnings.push(`Node ${nodeId} has malformed inputs. Export Save (API Format).`);continue;}
    if(node.outputs!=null&&!Array.isArray(node.outputs)){requiresApiExport=true;warnings.push(`Node ${nodeId} has malformed outputs. Export Save (API Format).`);continue;}
    if(node.widgets_values!=null&&!Array.isArray(node.widgets_values)){requiresApiExport=true;warnings.push(`Node ${nodeId} has malformed widget values. Export Save (API Format).`);continue;}
    if(node.mode != null && node.mode !== 0) continue;
    const inputNames=new Set<string>();let invalidInput=false;
    for(const input of node.inputs??[]){
      if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.name!=='string'||!input.name){requiresApiExport=true;warnings.push(`Node ${nodeId} contains a malformed input record. Export Save (API Format).`);invalidInput=true;break;}
      if(inputNames.has(input.name)){requiresApiExport=true;warnings.push(`Node ${nodeId} contains duplicate input name ${input.name}. Export Save (API Format).`);invalidInput=true;break;}
      inputNames.add(input.name);
    }
    if(invalidInput)continue;
    activeNodes.set(nodeId, node);
  }
  const links = new Map<string, NonNullable<ReturnType<typeof normalizeLink>>>();
  for (const raw of ui.links || []) {
    const normalized = normalizeLink(raw);
    if(!normalized){requiresApiExport=true;warnings.push('Workflow contains a malformed link record. Automatic conversion is unsafe; export Save (API Format).');continue;}
    if(links.has(normalized.id)){requiresApiExport=true;warnings.push(`Workflow contains duplicate link id ${normalized.id}. Automatic conversion is unsafe; export Save (API Format).`);continue;}
    links.set(normalized.id, normalized);
  }

  const consumedLinkIds=new Set<string>();
  for (const [nodeId, node] of activeNodes) {
    const schema=Object.prototype.hasOwnProperty.call(objectInfo,node.type)?objectInfo[node.type]:undefined;
    if (!schema) {
      const connected = Boolean(node.inputs?.some(input => input.link != null) || node.outputs?.some(output => (output.links?.length || 0) > 0));
      const looksLikeSubgraph = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(node.type);
      if (connected || looksLikeSubgraph) {
        requiresApiExport = true;
        warnings.push(`Node ${nodeId} (${node.type}) is an unknown connected node/subgraph. Automatic conversion is unsafe; open this workflow in ComfyUI and export Save (API Format).`);
      } else {
        warnings.push(`Node ${nodeId} (${node.type}) is not installed in this ComfyUI instance and was skipped because it is disconnected.`);
      }
      continue;
    }
    const inputs=Object.create(null) as Record<string,unknown>;
    const uiInputs = new Map((node.inputs || []).map(i => [i.name, i]));

    for (const input of node.inputs || []) {
      if (input.link == null) continue;
      const link = links.get(String(input.link));
      if(!link){requiresApiExport=true;warnings.push(`Node ${nodeId}.${input.name} references missing or malformed link ${String(input.link)}. Export Save (API Format).`);continue;}
      if(consumedLinkIds.has(link.id)){requiresApiExport=true;warnings.push(`Link ${link.id} is referenced by more than one target input. Export Save (API Format).`);continue;}
      consumedLinkIds.add(link.id);
      if(link.targetId!==nodeId){requiresApiExport=true;warnings.push(`Link ${link.id} targets node ${link.targetId} but is referenced by node ${nodeId}.${input.name}. Export Save (API Format).`);continue;}
      if (!activeNodes.has(link.originId)) {
        requiresApiExport=true;
        warnings.push(`Node ${nodeId}.${input.name} comes from disabled/bypassed node ${link.originId}; export Save (API Format).`);
        continue;
      }
      const originType=activeNodes.get(link.originId)!.type;
      if(!Object.prototype.hasOwnProperty.call(objectInfo,originType)){
        requiresApiExport=true;
        warnings.push(`Node ${nodeId}.${input.name} depends on unavailable node ${link.originId} (${originType}); export Save (API Format).`);
        continue;
      }
      inputs[input.name] = [link.originId, link.originSlot];
    }

    const widgets = [...(node.widgets_values || [])];
    let widgetIndex = 0;
    const schemaGroups = [schema.input?.required || {}, schema.input?.optional || {}];
    for (const group of schemaGroups) {
      for (const [name, definition] of Object.entries(group) as [string, any][]) {
        if (inputs[name] !== undefined) continue;
        const config = Array.isArray(definition) ? (definition[1] || {}) : {};
        const uiInput = uiInputs.get(name);
        const forced = Boolean(config?.forceInput);
        if (forced && !uiInput?.widget) continue;
        if (widgetIndex >= widgets.length) continue;
        let candidate = widgets[widgetIndex++];
        if (candidate && typeof candidate === 'object' && 'value' in (candidate as any)) candidate = (candidate as any).value;
        if (candidate === undefined) continue;
        inputs[name] = candidate;
      }
    }

    result[nodeId] = { class_type: node.type, inputs, ...(node.title ? { _meta: { title: node.title } } : {}) };
  }

  for (const node of Object.values(result)) {
    for (const [name, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && !result[value[0]]) {
        delete node.inputs[name];
        requiresApiExport=true;
        warnings.push(`Removed unresolved link ${node.class_type}.${name} -> ${value[0]}. Export Save (API Format).`);
      }
    }
  }
  return { workflow: result, warnings, requiresApiExport };
}
