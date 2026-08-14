/**
 * `acp` domain — built-in ACP Feature registration.
 */

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

export class AcpFeature extends Feature {
  static override readonly name = 'acp';

  constructor() {
    super();
    this.contributeAgentService(IAcpService, AcpService);
    this.contributeTool(IAcpCompressTool, AcpCompressTool, { name: 'compress' });
    this.contributeTool(IAcpDecompressTool, AcpDecompressTool, { name: 'decompress' });
    this.contributeTool(IAcpSearchContextTool, AcpSearchContextTool, { name: 'search_context' });
    this.contributeTool(IAcpStatusTool, AcpStatusTool, { name: 'acp_status' });
  }
}

registerFeature(AcpFeature);
