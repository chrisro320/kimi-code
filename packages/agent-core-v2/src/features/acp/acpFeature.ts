/**
 * `acp` domain — built-in ACP Feature registration.
 */

import type { ServicesAccessor } from '#/_base/di/instantiation';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';

import { IAcpService } from './acp';
import { AcpService } from './acpService';
import { IAcpStatusTool } from './tools/acp-status/acp-status';
import { AcpStatusTool } from './tools/acp-status/acpStatusTool';
import { IAcpCompressTool } from './tools/compress/compress';
import { AcpCompressTool } from './tools/compress/compressTool';
import { IAcpDecompressTool } from './tools/decompress/decompress';
import { AcpDecompressTool } from './tools/decompress/decompressTool';
import { IAcpSearchContextTool } from './tools/search-context/search-context';
import { AcpSearchContextTool } from './tools/search-context/searchContextTool';

const onlyMainAgent = (accessor: ServicesAccessor) =>
  accessor.get(IAgentScopeContext).agentId === 'main';

export class AcpFeature extends Feature {
  static override readonly name = 'acp';

  constructor() {
    super();
    this.contributeAgentService(IAcpService, AcpService);
    this.contributeTool(IAcpCompressTool, AcpCompressTool, {
      name: 'compress',
      domain: 'acp',
      when: onlyMainAgent,
    });
    this.contributeTool(IAcpDecompressTool, AcpDecompressTool, {
      name: 'decompress',
      domain: 'acp',
      when: onlyMainAgent,
    });
    this.contributeTool(IAcpSearchContextTool, AcpSearchContextTool, {
      name: 'search_context',
      domain: 'acp',
      when: onlyMainAgent,
    });
    this.contributeTool(IAcpStatusTool, AcpStatusTool, {
      name: 'acp_status',
      domain: 'acp',
      when: onlyMainAgent,
    });
  }
}

registerFeature(AcpFeature);
