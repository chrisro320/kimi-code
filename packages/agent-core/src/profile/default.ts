import agentYaml from './default/agent.yaml?raw';
import coderExYaml from './default/coder-ex.yaml?raw';
import coderYaml from './default/coder.yaml?raw';
import debuggerYaml from './default/debugger.yaml?raw';
import exploreYaml from './default/explore.yaml?raw';
import frontendArtistYaml from './default/frontend-artist.yaml?raw';
import initMd from './default/init.md?raw';
import reviewerYaml from './default/reviewer.yaml?raw';
import systemMd from './default/system.md?raw';
import { loadAgentProfilesFromSources } from './load';

// Keyed by the source path the profile loader expects: profile YAML files
// plus any file referenced through `systemPromptPath`.
const PROFILE_SOURCES: Record<string, string> = {
  'profile/default/agent.yaml': agentYaml,
  'profile/default/coder-ex.yaml': coderExYaml,
  'profile/default/coder.yaml': coderYaml,
  'profile/default/debugger.yaml': debuggerYaml,
  'profile/default/explore.yaml': exploreYaml,
  'profile/default/frontend-artist.yaml': frontendArtistYaml,
  'profile/default/reviewer.yaml': reviewerYaml,
  'profile/default/system.md': systemMd,
};

export const DEFAULT_INIT_PROMPT = initMd;

export const DEFAULT_AGENT_PROFILES = loadAgentProfilesFromSources(
  ['agent.yaml', 'coder-ex.yaml', 'coder.yaml', 'debugger.yaml', 'explore.yaml', 'frontend-artist.yaml', 'reviewer.yaml'].map(
    (file) => `profile/default/${file}`,
  ),
  PROFILE_SOURCES,
);
