/**
 * Copyright (c) 2020 SUSE LLC
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 * the Software, and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
 * FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
 * COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
 * IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
 * CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

import { expect } from "chai";
import { promises as fsPromises } from "fs";
import { afterEach, beforeEach, Context, describe } from "mocha";
import { join } from "path";
import { setPackageMeta } from "../../src/api/package-meta";
import { ProjectMeta } from "../../src/api/project-meta";
import { calculateHash } from "../../src/checksum";
import { fetchHistory } from "../../src/history";
import { checkOutPackage, FrozenPackage } from "../../src/package";
import { createProject, deleteProject } from "../../src/project";
import { pathExists, rmRf } from "../../src/util";
import {
  addAndDeleteFilesFromPackage,
  commit,
  FileState,
  readInModifiedPackageFromDir
} from "../../src/vcs";
import {
  ApiType,
  castToAsyncFunc,
  createTemporaryDirectory,
  getTestConnection,
  miniObsUsername,
  skipIfNoMiniObsHook
} from "../test-setup";

type TestFixture = Context & {
  testPkg: FrozenPackage;
  testProjMeta: ProjectMeta;
  checkoutPath: string;
  tmpPath: string;
};

describe("ModifiedPackage", function () {
  this.timeout(10000);

  before(skipIfNoMiniObsHook);
  const con = getTestConnection(ApiType.MiniObs);

  beforeEach(async function () {
    this.tmpPath = await createTemporaryDirectory();

    this.testPkg = Object.freeze({
      apiUrl: ApiType.MiniObs,
      name: "test_package",
      projectName: `home:${miniObsUsername}:test`,
      files: [],
      md5Hash: "notReallyAHash"
    });
    this.testProjMeta = {
      name: this.testPkg.projectName,
      description: "test project",
      title: "Test project"
    };

    this.checkoutPath = join(this.tmpPath, this.testPkg.name);
  });

  afterEach(async function () {
    await deleteProject(con, this.testPkg.projectName);
    await rmRf(this.tmpPath);
  });

  const createAndCheckoutPkg = async (ctx: TestFixture) => {
    await createProject(con, ctx.testProjMeta);

    await setPackageMeta(con, ctx.testPkg.projectName, ctx.testPkg.name, {
      name: ctx.testPkg.name,
      title: "Test Package",
      description: "Just a package for testing"
    });

    await checkOutPackage(ctx.testPkg, ctx.checkoutPath);
  };

  describe("#commit", () => {
    it(
      "commits a simple package",
      castToAsyncFunc<TestFixture>(async function () {
        await createAndCheckoutPkg(this);

        // we create some testfiles with a preset time stamp, as otherwise the
        // recorded requests with OBS will never match
        const modifiedTime = new Date("Mon, 3 Dec 2018");
        await Promise.all(
          ["foo", "bar", "baz"].map(async (fname) => {
            const path = join(this.tmpPath, this.testPkg.name, `${fname}.txt`);
            const fd = await fsPromises.open(path, "w");
            await fd.write(Buffer.from(`${fname}.txt contains just ${fname}`));
            await fd.utimes(modifiedTime, modifiedTime);
            await fd.close();
          })
        );

        let modPkg = await readInModifiedPackageFromDir(
          join(this.tmpPath, this.testPkg.name)
        );

        expect(modPkg.filesInWorkdir).to.have.length(3);

        ["foo.txt", "bar.txt", "baz.txt"].forEach((f) =>
          expect(
            modPkg.filesInWorkdir!.find((file) => f === file.name)
          ).to.deep.include({
            name: f,
            state: FileState.Untracked,
            projectName: this.testPkg.projectName,
            packageName: this.testPkg.name
          })
        );

        modPkg = await addAndDeleteFilesFromPackage(modPkg, [], ["foo.txt"]);
        const fooContents = Buffer.from("foo.txt contains just foo");

        expect(modPkg.filesInWorkdir).to.have.length(3);
        ["bar", "baz"].forEach((untrackedFname) =>
          expect(
            modPkg.filesInWorkdir.find(
              (f) => f.name === `${untrackedFname}.txt`
            )
          ).to.deep.include({
            name: `${untrackedFname}.txt`,
            state: FileState.Untracked
          })
        );
        // now that the file has been explicitly added, we should have *all*
        // metadata
        expect(
          modPkg.filesInWorkdir.find((f) => f.name === "foo.txt")
        ).to.deep.equal({
          name: "foo.txt",
          state: FileState.ToBeAdded,
          projectName: this.testPkg.projectName,
          packageName: this.testPkg.name,
          contents: fooContents,
          md5Hash: calculateHash(fooContents, "md5"),
          size: fooContents.length,
          modifiedTime
        });

        const msg = "Add foo.txt";

        modPkg = await commit(con, modPkg, msg);
        expect(
          modPkg.filesInWorkdir.find((f) => f.name === "foo.txt")
        ).to.deep.include({
          name: "foo.txt",
          state: FileState.Unmodified
        });
        ["bar", "baz"].forEach((untrackedFname) =>
          expect(
            modPkg.filesInWorkdir.find(
              (f) => f.name === `${untrackedFname}.txt`
            )
          ).to.deep.include({
            name: `${untrackedFname}.txt`,
            state: FileState.Untracked
          })
        );

        const hist = await fetchHistory(con, modPkg);
        hist.should.have.length(1);
        hist[0].should.deep.include({
          commitMessage: msg,
          revisionHash: modPkg.md5Hash
        });

        // now let's add bar and remove foo, don't touch baz
        modPkg = await addAndDeleteFilesFromPackage(
          modPkg,
          ["foo.txt"],
          ["bar.txt"]
        );

        expect(await pathExists(join(modPkg.path, "foo.txt"))).to.equal(
          undefined
        );

        const msg2 = "Add bar.txt, remove foo.txt";
        modPkg = await commit(con, modPkg, msg2);

        const laterHist = await fetchHistory(con, modPkg);
        laterHist.should.have.length(2);
        laterHist[1].should.deep.include({
          commitMessage: msg2,
          revisionHash: modPkg.md5Hash
        });

        expect(modPkg.filesInWorkdir).to.have.length(2);
        expect(
          modPkg.filesInWorkdir.find((f) => f.name === "baz.txt")
        ).to.deep.include({
          name: "baz.txt",
          state: FileState.Untracked
        });
        expect(
          modPkg.filesInWorkdir.find((f) => f.name === "bar.txt")
        ).to.deep.include({
          name: "bar.txt",
          state: FileState.Unmodified
        });

        // now add bar as well
        modPkg = await addAndDeleteFilesFromPackage(modPkg, [], ["baz.txt"]);
        const msg3 = "Add baz.txt on top of that";

        modPkg = await commit(con, modPkg, msg3);
        modPkg.filesInWorkdir.should.all.have.property(
          "state",
          FileState.Unmodified
        );

        const lastHist = await fetchHistory(con, modPkg);
        lastHist.should.have.length(3);
        lastHist[2].should.deep.include({
          commitMessage: msg3,
          revisionHash: modPkg.md5Hash
        });
      })
    );

    it(
      "cleans up .osc/_to_be_added and .osc/_to_be_deleted after a commit",
      castToAsyncFunc<TestFixture>(async function () {
        await createAndCheckoutPkg(this);
        const spec = "testfile.spec";

        await fsPromises.writeFile(
          join(this.checkoutPath, spec),
          Buffer.from("this is not really a specfile ;-)")
        );

        const modifiedPkg = await readInModifiedPackageFromDir(
          this.checkoutPath
        );

        const pkgWithAddedFiles = await addAndDeleteFilesFromPackage(
          modifiedPkg,
          [],
          [spec]
        );
        const modifiedPkgAfterCommit = await commit(
          con,
          pkgWithAddedFiles,
          `Add ${spec}`
        );

        await readInModifiedPackageFromDir(
          this.checkoutPath
        ).should.eventually.deep.equal(modifiedPkgAfterCommit);

        const pkgWithDeletedSpec = await addAndDeleteFilesFromPackage(
          modifiedPkgAfterCommit,
          [spec],
          []
        );

        const afterDeleteCommit = await commit(
          con,
          pkgWithDeletedSpec,
          `Delete ${spec}`
        );
        await readInModifiedPackageFromDir(
          this.checkoutPath
        ).should.eventually.deep.equal(afterDeleteCommit);
      })
    );
  });
});
