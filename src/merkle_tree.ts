import { LevelUp, LevelUpChain } from 'levelup';
import { HashPath } from './hash_path';
import { Sha256Hasher } from './sha256_hasher';

const MAX_DEPTH = 32;
const LEAF_BYTES = 64; // All leaf values are 64 bytes.

/**
 * The merkle tree, in summary, is a data structure with a number of indexable elements, and the property
 * that it is possible to provide a succinct proof (HashPath) that a given piece of data, exists at a certain index,
 * for a given merkle tree root.
 */
export class MerkleTree {
  private hasher = new Sha256Hasher();
  private root: Buffer;

  // [0] -> default leafHash
  private defaultHashes: Buffer[];

  // [0] -> leafLevel
  private nodes: Buffer[][];


  /**
   * Constructs a new MerkleTree instance, either initializing an empty tree, or restoring pre-existing state values.
   * Use the async static `new` function to construct.
   *
   * @param db Underlying leveldb.
   * @param name Name of the tree, to be used when restoring/persisting state.
   * @param depth The depth of the tree, to be no greater than MAX_DEPTH.
   * @param root When restoring, you need to provide the root.
   */
  constructor(private db: LevelUp, private name: string, private depth: number, root?: Buffer) {
    if (!(depth >= 1 && depth <= MAX_DEPTH)) {
      throw Error('Bad depth');
    }

    this.nodes = Array.from({ length: depth }, () => []);
    this.defaultHashes = this.precomputeDefaultHashes(depth);

    if (!root) {
      this.root = this.emptyRoot()
    } else {
      this.root = root;
    }
  }


  /**
   * Constructs or restores a new MerkleTree instance with the given `name` and `depth`.
   * The `db` contains the tree data.
   */
  static async new(db: LevelUp, name: string, depth = MAX_DEPTH) {
    const meta: Buffer = await db.get(Buffer.from(name)).catch(() => { });
    if (meta) {
      const root = meta.slice(0, 32);
      const depth = meta.readUInt32LE(32);
      return new MerkleTree(db, name, depth, root);
    } else {
      const tree = new MerkleTree(db, name, depth);
      await tree.writeMetaData();
      return tree;
    }
  }

  private async writeMetaData(batch?: LevelUpChain<string, Buffer>) {
    const data = Buffer.alloc(40);
    this.root.copy(data);
    data.writeUInt32LE(this.depth, 32);
    if (batch) {
      batch.put(this.name, data);
    } else {
      await this.db.put(this.name, data);
    }
  }

  getRoot() {
    return this.root;
  }

  /**
   * Returns the hash path for `index`.
   * e.g. To return the HashPath for index 2, return the nodes marked `*` at each layer.
   *     d3:                                            [ root ]
   *     d2:                      [*]                                               [*]
   *     d1:         [*]                      [*]                       [ ]                     [ ]
   *     d0:   [ ]         [ ]          [*]         [*]           [ ]         [ ]          [ ]        [ ]
   */
  async getHashPath(index: number) {
    if (!(index >= 0 && index < 2 ** this.depth)) {
      throw Error('Bad index');
    }
    // The path to the root will always contain depth - 1 levels (excludes root)
    const path: Buffer[][] = [];

    let i = index
    for (let lvl = 0; lvl < this.depth; lvl++) {
      // const nodesAtLvl = this.nodes[lvl];
      const lIndex = this.isLeftChild(i) ? i : i - 1;
      const l = await this.getNode(lvl, lIndex);

      const rIndex = lIndex + 1;
      const r = await this.getNode(lvl, rIndex);

      path[lvl] = [l, r];
      i = Math.floor(i / 2);
    }

    // [0] -> [lleaf, rleaf]
    return new HashPath(path);
  }

  /**
   * Updates the tree with `value` at `index`. Returns the new tree root.
   */
  async updateElement(index: number, value: Buffer) {
    if (!(index >= 0 && index < 2 ** this.depth)) {
      throw Error('Bad index');
    }
    const batch = this.db.batch();

    // update leaf
    this.storeNode(batch, 0, index, this.hasher.hash(value));


    // Update Tree Nodes on the hash path
    let i = index;
    let lvl = 0;
    for (; ;) {
      // Left child
      const lIndex = this.isLeftChild(i) ? i : i - 1;
      const l = await this.getNode(lvl, lIndex);

      // Right child
      const rIndex = lIndex + 1;
      const r = await this.getNode(lvl, rIndex);


      const notReachedRoot = lvl + 1 < this.depth;
      if (notReachedRoot) {
        const parentIndex = Math.floor(i / 2);
        const parentLevel = lvl + 1;
        const parentHash = this.hasher.compress(l, r);
        this.storeNode(batch, parentLevel, parentIndex, parentHash);
        i = parentIndex;
        lvl++;

      } else {
        this.root = this.hasher.compress(l, r);
        break;
      }

    }

    this.writeMetaData(batch);
    batch.write();
    return this.root;
  }

  async storeNode(batch: LevelUpChain<string, Buffer>, level: number, index: number, node: Buffer) {
    this.nodes[level]![index] = node;
    batch.put(`${level}-${index}`, node);
  }

  async getNode(level: number, index: number) {
    const inMemNode = this.nodes[level]![index];

    // Node has been updated in this process
    if (inMemNode) {
      return inMemNode;
    }

    try {
      // Node has been updated in a previous process
      return await this.db.get(`${level}-${index}`);
    } catch (err) {
      if (err.notFound) {
        // Node never been updated so return default hash
        return this.defaultHashes[level];
      }

      throw err;
    }

  }

  precomputeDefaultHashes(depth: number): Array<Buffer> {
    let arr = new Array(depth);

    // Precompute default hash values
    let hash = this.hasher.hash(Buffer.alloc(64)); // 64 zero bytes
    for (let level = 0; level < depth; level++) {
      arr[level] = hash;
      // console.log(level + " -> " + arr[level].toString('hex'))

      hash = this.hasher.compress(hash, hash);
    }


    return arr;
  }

  isLeftChild(index: number) {
    return index % 2 === 0;
  }

  emptyRoot() {
    let rootChildLvl = this.defaultHashes[this.depth - 1].slice(0, 32);
    return this.hasher.compress(rootChildLvl, rootChildLvl);
  }

}
