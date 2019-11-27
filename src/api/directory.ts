import { Connection } from "../connection";
import {
  deleteUndefinedAndEmptyMembers,
  extractElementAsArrayIfPresent
} from "../util";

/**
 * Functions and objects to interact with an API route using the
 * [directory](https://build.opensuse.org/apidocs/directory.xsd) schema.
 */

/** One entry in the directory. It's identified by its name. */
export interface DirectoryEntry {
  name?: string;
  size?: string;
  md5?: string;
  mtime?: string;
  originproject?: string;
  available?: boolean;
  recommended?: boolean;
}

/** Information about the source link. */
export interface LinkInfo {
  project?: string;
  package?: string;
  srcmd5?: string;
  rev?: string;
  baserev?: string;
  xsrcmd5?: string;
  lsrcmd5?: string;
  error?: string;
}

/** Information about source service run of last commit. */
export interface ServiceInfo {
  code?: string;
  error?: string;
  xsrcmd5?: string;
  lsrcmd5?: string;
}

interface DirectoryEntryApiReply {
  $: DirectoryEntry;
}

function directoryEntryFromApi(dentry: DirectoryEntryApiReply): DirectoryEntry {
  return dentry.$;
}

interface LinkInfoApiReply {
  $: LinkInfo;
}

function linkInfoFromApi(linkInfo: LinkInfoApiReply): LinkInfo {
  return linkInfo.$;
}

interface ServiceInfoApiReply {
  $: ServiceInfo;
}

function serviceInfoFromApi(serviceInfo: ServiceInfoApiReply): ServiceInfo {
  return serviceInfo.$;
}

interface DirectoryApiReply {
  /**  Directory listing */
  directory: {
    $: { rev?: string; srcmd5?: string; count?: number };
    entry?: DirectoryEntryApiReply[];
    linkinfo?: LinkInfoApiReply[];
    serviceinfo?: ServiceInfoApiReply[];
  };
}

export interface Directory {
  readonly revision?: string;
  readonly sourceMd5?: string;
  readonly count?: number;

  readonly directoryEntries?: DirectoryEntry[];
  readonly linkInfos?: LinkInfo[];
  readonly serviceInfos?: ServiceInfo[];
}

export async function getDirectory(
  con: Connection,
  route: string
): Promise<Directory> {
  const response: DirectoryApiReply = await con.makeApiCall(route);

  const dir: Directory = {
    revision: response.directory.$.rev,
    sourceMd5: response.directory.$.srcmd5,
    count: response.directory.$.count,
    directoryEntries: extractElementAsArrayIfPresent(
      response.directory,
      "entry",
      { construct: directoryEntryFromApi }
    ),
    linkInfos: extractElementAsArrayIfPresent(response.directory, "linkinfo", {
      construct: linkInfoFromApi
    }),
    serviceInfos: extractElementAsArrayIfPresent(
      response.directory,
      "serviceinfo",
      { construct: serviceInfoFromApi }
    )
  };

  deleteUndefinedAndEmptyMembers(dir);
  return dir;
}