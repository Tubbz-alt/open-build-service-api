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
import mockFs = require("mock-fs");

import { expect } from "chai";
import { promises as fsPromises } from "fs";
import { describe, it } from "mocha";
import { join } from "path";
import { calculateHash } from "../src/checksum";
import { FrozenPackageFile } from "../src/file";
import { pathExists, PathType } from "../src/util";
import {
  addAndDeleteFilesFromPackage,
  FileState,
  ModifiedPackage,
  readInModifiedPackageFromDir,
  undoFileDeletion,
  untrackFiles,
  VcsFile
} from "../src/vcs";
import { setupPackageFileMock } from "./test-setup";

describe("ModifiedPackage", () => {
  const pkgBase = {
    apiUrl: "https://api.foobar.org",
    name: "fooPkg",
    projectName: "fooProj",
    md5Hash: "somethingSomethingButNotAHash"
  };

  const files: FrozenPackageFile[] = ["foo", "bar"].map((name) => ({
    name,
    packageName: pkgBase.name,
    projectName: pkgBase.projectName,
    md5Hash: calculateHash(Buffer.from(name), "md5"),
    modifiedTime: (() => {
      const d = new Date();
      d.setMilliseconds(0);
      return d;
    })(),
    contents: Buffer.from(name),
    size: 3
  }));

  afterEach(() => mockFs.restore());

  describe("#readInModifiedPackageFromDir", () => {
    it("reads in the files from .osc/_to_be_added", async () => {
      setupPackageFileMock(
        { ...pkgBase, files: [] },
        {
          additionalFiles: {
            ".osc/_to_be_added": `foo
bar
`,
            foo: "",
            bar: `bar is not empty!
`
          }
        }
      );

      const modifiedPkg: ModifiedPackage = await readInModifiedPackageFromDir(
        "."
      ).should.eventually.deep.include({
        ...pkgBase,
        path: "."
      });

      modifiedPkg.should.have
        .property("filesInWorkdir")
        .that.is.an("array")
        .and.has.length(2);

      const filesInWorkdir = modifiedPkg.filesInWorkdir;
      filesInWorkdir.forEach((f) => f.state.should.equal(FileState.ToBeAdded));
      expect(filesInWorkdir.map((f) => f.name)).to.deep.equal(["foo", "bar"]);
    });

    it("reads in the files from .osc/_to_be_deleted", async () => {
      setupPackageFileMock(
        {
          ...pkgBase,
          files
        },
        {
          additionalFiles: {
            ".osc/_to_be_deleted": `foo
bar
`
          },
          addFilesToCwd: false
        }
      );

      const modifiedPkg: ModifiedPackage = await readInModifiedPackageFromDir(
        "."
      ).should.eventually.deep.include({
        ...pkgBase,
        path: "."
      });

      modifiedPkg.should.have
        .property("filesInWorkdir")
        .that.is.an("array")
        .and.has.length(2);

      const filesInWorkdir = modifiedPkg.filesInWorkdir;
      filesInWorkdir.forEach((f) =>
        f.state.should.equal(FileState.ToBeDeleted)
      );
      expect(filesInWorkdir.map((f) => f.name)).to.deep.equal(["foo", "bar"]);
    });

    it("it adds untracked files", async () => {
      setupPackageFileMock(
        {
          ...pkgBase,
          files
        },
        {
          additionalFiles: {
            baz: "well, not really anything meaningful in here..."
          }
        }
      );

      const modifiedPkg: ModifiedPackage = await readInModifiedPackageFromDir(
        "."
      ).should.eventually.deep.include({
        ...pkgBase,
        path: "."
      });

      modifiedPkg.should.have
        .property("filesInWorkdir")
        .that.is.an("array")
        .and.has.length(3);

      const filesInWorkdir = modifiedPkg.filesInWorkdir;
      expect(
        filesInWorkdir.find((f: VcsFile) => f.name === "baz")
      ).to.deep.include({ name: "baz", state: FileState.Untracked });
      ["foo", "bar"].forEach((unmodifiedFname) =>
        expect(
          filesInWorkdir.find((f) => f.name === unmodifiedFname)
        ).to.deep.include({
          name: unmodifiedFname,
          state: FileState.Unmodified
        })
      );
    });

    it("it marks files with different contents as modified", async () => {
      const fooContents = `nothin'
in
here
`;
      setupPackageFileMock(
        {
          ...pkgBase,
          files
        },
        {
          additionalFiles: {
            foo: fooContents,
            bar: "bar"
          },
          addFilesToCwd: false
        }
      );

      const modifiedPkg: ModifiedPackage = await readInModifiedPackageFromDir(
        "."
      ).should.eventually.deep.include({
        ...pkgBase,
        path: "."
      });

      modifiedPkg.should.have
        .property("files")
        .that.is.an("array")
        .and.has.length(2);

      const filesInWorkdir = modifiedPkg.filesInWorkdir;
      expect(filesInWorkdir.find((f) => f.name === "foo")).to.deep.include({
        name: "foo",
        state: FileState.Modified,
        contents: Buffer.from(fooContents)
      });
      expect(filesInWorkdir.find((f) => f.name === "bar")).to.deep.include({
        name: "bar",
        state: FileState.Unmodified
      });
    });

    it("it finds missing files", async () => {
      setupPackageFileMock(
        {
          ...pkgBase,
          files
        },
        {
          addFilesToCwd: false
        }
      );

      const modifiedPkg: ModifiedPackage = await readInModifiedPackageFromDir(
        "."
      ).should.eventually.deep.include({
        ...pkgBase,
        path: "."
      });

      modifiedPkg.should.have
        .property("filesInWorkdir")
        .that.is.an("array")
        .and.has.length(2);

      const filesInWorkdir = modifiedPkg.filesInWorkdir;
      ["foo", "bar"].forEach((fname) =>
        expect(filesInWorkdir.find((f) => f.name === fname)).to.deep.include({
          name: fname,
          state: FileState.Missing
        })
      );
    });

    it("it handles deleted files that still exist sanely", async () => {
      setupPackageFileMock(
        {
          ...pkgBase,
          files
        },
        {
          additionalFiles: {
            ".osc/_to_be_deleted": `foo
bar
`,
            foo: "something foo, or maybe bar?"
          },
          addFilesToCwd: false
        }
      );

      const modifiedPkg = await readInModifiedPackageFromDir(".");
      modifiedPkg.should.deep.include({
        ...pkgBase,
        path: "."
      });

      modifiedPkg.should.have
        .property("filesInWorkdir")
        .that.is.an("array")
        .and.has.length(2);

      const filesInWorkdir = modifiedPkg.filesInWorkdir;
      filesInWorkdir.forEach((f) =>
        f.state.should.equal(FileState.ToBeDeleted)
      );
      ["foo", "bar"].forEach((deletedFileName) =>
        expect(
          filesInWorkdir.map((f) => f.name)
        ).to.include.a.thing.that.deep.equals(deletedFileName)
      );
    });
  });

  describe("#addAndDeleteFilesFromPackage", () => {
    const modifiedPkgBase = {
      apiUrl: "https://api.foo.org",
      name: "foo",
      projectName: "fooProj",
      path: "/path/to/fooProj/foo"
    };

    const dummyContents = {
      md5Hash: "irrelevant",
      contents: Buffer.from("a"),
      size: 1,
      modifiedTime: new Date()
    };

    it("rejects overlapping file additions and removals", async () => {
      await addAndDeleteFilesFromPackage(
        {
          filesInWorkdir: [],
          files: [],
          ...modifiedPkgBase
        },
        ["fileA"],
        ["fileA"]
      ).should.be.rejectedWith(/cannot.*add.*and.*remove.*file.*fileA/i);
    });

    it("rejects adding files that are not untracked", async () => {
      const missing = {
        name: "missingFile",
        projectName: modifiedPkgBase.projectName,
        packageName: modifiedPkgBase.name,
        ...dummyContents
      };
      await addAndDeleteFilesFromPackage(
        {
          filesInWorkdir: [{ ...missing, state: FileState.Missing }],
          files: [missing],
          ...modifiedPkgBase
        },
        [],
        ["missingFile"]
      ).should.be.rejectedWith(/missingFile.*not untracked/);
    });

    it("rejects removing files that are not tracked", async () => {
      const untracked = {
        name: "untrackedFile",
        projectName: modifiedPkgBase.projectName,
        packageName: modifiedPkgBase.name,
        ...dummyContents
      };
      await addAndDeleteFilesFromPackage(
        {
          filesInWorkdir: [{ ...untracked, state: FileState.Untracked }],
          files: [untracked],
          ...modifiedPkgBase
        },
        ["untrackedFile"],
        []
      ).should.be.rejectedWith(/untrackedFile.*not tracked/);
    });

    it("deletes _to_be_added if no files are to be added", async () => {
      setupPackageFileMock(
        { ...pkgBase, files: [files[1]] },
        { additionalFiles: { foo: files[0].contents } }
      );
      let pkg = await readInModifiedPackageFromDir(".");

      await fsPromises.writeFile(join(".osc", "_to_be_added"), "baz", "utf8");

      pkg = await addAndDeleteFilesFromPackage(pkg, ["bar"], []);

      await pathExists(
        ".osc/_to_be_deleted",
        PathType.File
      ).should.eventually.not.equal(undefined);
      await pathExists(
        ".osc/_to_be_added",
        PathType.File
      ).should.eventually.equal(undefined);
    });
  });

  describe("#untrackFiles", () => {
    beforeEach(async function () {
      setupPackageFileMock(
        { ...pkgBase, files: [files[0]] },
        { additionalFiles: { bar: files[1].contents, baz: "buzzy bee" } }
      );
      this.modPkg = await readInModifiedPackageFromDir(".");
      expect(this.modPkg.files).to.be.an("array").and.have.length(1);
      expect(this.modPkg.filesInWorkdir).to.be.an("array").and.have.length(3);
    });

    it("changes the state of files to be added", async function () {
      const pkgName = "bar";
      const pkgWithBarTracked = await addAndDeleteFilesFromPackage(
        this.modPkg,
        [],
        [pkgName]
      );
      expect(
        pkgWithBarTracked.filesInWorkdir.find((p) => p.name === pkgName)
      ).to.deep.include({ name: pkgName, state: FileState.ToBeAdded });

      const pkgWithBarUntracked = await untrackFiles(pkgWithBarTracked, [
        pkgName
      ]);
      expect(
        pkgWithBarUntracked.filesInWorkdir.find((p) => p.name === pkgName)
      ).to.deep.include({ name: pkgName, state: FileState.Untracked });
    });

    it("throws an exception when a non-existent file is to be untracked", async function () {
      await untrackFiles(this.modPkg, ["not existent"]).should.be.rejectedWith(
        /cannot untrack.*not existent.*not to be added/i
      );
    });

    it("throws an exception when a file that is not to be added is to be untracked", async function () {
      await untrackFiles(this.modPkg, ["foo"]).should.be.rejectedWith(
        /cannot untrack.*foo.*not to be added/i
      );
    });

    it("correctly registers the new file state in .osc", async function () {
      const pkgName = "bar";
      const pkgWithBarTracked = await addAndDeleteFilesFromPackage(
        this.modPkg,
        [],
        [pkgName]
      );

      const pkg = await untrackFiles(pkgWithBarTracked, [pkgName]);
      await readInModifiedPackageFromDir(".").should.eventually.deep.equal(pkg);
    });
  });

  describe("#undoFileDeletion", () => {
    beforeEach(async function () {
      setupPackageFileMock(
        { ...pkgBase, files },
        {
          additionalFiles: {
            ".osc/_to_be_deleted": `${files[1].name}`,
            baz: "buzzy bee"
          },
          addFilesToCwd: false
        }
      );
      const pkg = await readInModifiedPackageFromDir(".");

      expect(pkg.files).to.be.an("array").and.have.length(2);
      expect(pkg.filesInWorkdir).to.be.an("array").and.have.length(3);
      expect(
        pkg.filesInWorkdir.find((f: VcsFile) => f.name === files[0].name)
      ).to.deep.include({ name: files[0].name, state: FileState.Missing });
      expect(
        pkg.filesInWorkdir.find((f: VcsFile) => f.name === files[1].name)
      ).to.deep.include({ name: files[1].name, state: FileState.ToBeDeleted });

      this.pkg = pkg;
    });

    it("restores a missing file", async function () {
      const pkg = await undoFileDeletion(this.pkg, [files[0].name]);

      const readInPkg = await readInModifiedPackageFromDir(".");

      const { filesInWorkdir: files1, ...restOfPkg } = pkg;
      const { filesInWorkdir: files2, ...restOfReadInPkg } = readInPkg;
      restOfPkg.should.deep.equal(restOfReadInPkg);

      expect(files1).to.have.length(files2.length);

      files1.forEach((f) => files2.should.include.a.thing.that.deep.equals(f));

      expect(
        pkg.filesInWorkdir.find((pkg) => pkg.name === files[0].name)
      ).to.deep.include({ ...files[0], state: FileState.Unmodified });
    });

    it("restores a deleted file", async function () {
      const pkg = await undoFileDeletion(this.pkg, [files[1].name]);

      const readInPkg = await readInModifiedPackageFromDir(".");

      const { filesInWorkdir: files1, ...restOfPkg } = pkg;
      const { filesInWorkdir: files2, ...restOfReadInPkg } = readInPkg;
      restOfPkg.should.deep.equal(restOfReadInPkg);

      expect(files1).to.have.length(files2.length);

      files1.forEach((f) => files2.should.include.a.thing.that.deep.equals(f));

      expect(
        pkg.filesInWorkdir.find((pkg) => pkg.name === files[1].name)
      ).to.deep.include({ ...files[1], state: FileState.Unmodified });
    });

    it("does nothing when filesToUndelete is empty", async function () {
      await undoFileDeletion(this.pkg, []).should.eventually.deep.equal(
        this.pkg
      );
    });

    it("throws an exception when a file that does not exist is to be reverted", async function () {
      await undoFileDeletion(this.pkg, ["baz"]).should.be.rejectedWith(
        /cannot undelete.*baz/i
      );
    });

    it("throws an exception when a file that is not deleted should be reverted", async function () {
      const pkg = await undoFileDeletion(this.pkg, ["bar"]);
      await undoFileDeletion(pkg, ["bar"]).should.be.rejectedWith(
        /cannot undelete.*bar/i
      );
    });
  });
});
