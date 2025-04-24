# README



## Features

- automatically update markdown reference after moving file or directory.

  Currently, it supports recognizing two type of formats: "Markdown references" and `src="path/to/file.ext"`. For example: `[haha](other_doc.md#header)`, `[image](./.images/myimage.png)`, `<img src=".Images/2022-04-27-21-41-41.png" style="zoom:25%">`, and so on.

  Meanwhile, this plugin also preserves 'id', such as [test](test.md#header) — the '#header' part will remain intact after relocation.

  Finally, even after some rather aggressive stress-testing with file and directory movements, the plugin maintained accuracy. Thus, I consider it reasonably robust. The only problem is that VSCode does not auto-save modifications to unopened files. You must manually save to update the plugin’s cache; otherwise, subsequent file/directory movement might fail to update all references (potentially causing text loss or corruption).

- update markdown reference after renaming header

  The plugin provides header renaming functionality. Press F2 to rename a markdown header, and it will automatically update all references to that header across other files.

- providing supports for 'header labels' like this:
  ```md
  ### Matrix Transformation
  <attr labels="math;lineary-algebra;matrix"></attr>
  ```

  feel free to name your tag (only these characters are forbidden: .&"'<>), unicode is also support.

### More about label
To use the label feature, the plugin requires you to provide a label configuration file. You can specify its path by configuring `markdown-note-supports.labelTreePath`. By default, it reads the `./labels.tree` file under workspace.

The label configuration file should be like:
```tree
- labelA
  - labelC
  - labelD
    - labelF
- labelB
```

there is some constraint for label naming:
- duplicate sibling labels are prohibited
- labels must not contain certain special symbols (.%"'<>)

#### Use label
For now, label is only supported for headers. Labels must be declared in the line immediately following the header (empty lines in between are allowed but unnecessary). For example:
```md
##### my header
<attr labels="label1;label2;label3.label4"></attr>
```

When the plugin loads the label configuration file, it will provide **auto-completion suggestions** based on the configuration.

![completion example](./image.png).

#### Unique label
When a label name is unique, you can reference it directly. On the other hand, if duplicate label names exist in the configuration (under different paths), you must build a 'labelpath' which start from a uniquely parent label.

for example, saying we had `labels.tree` below:
```tree
- somelabel
  - fruit
    - apple
    - banana
  - phone brand
    - apple
    - samsung
```

then we can use label like this:
```md
##### Good fruit
<attr labels="banana;fruit.apple"></attr>

##### Phone
<attr labels="samsung;phone brand.apple"></attr>

##### Also work
<attr labels="samsung;somelabel.phone brand.apple"></attr>
```

Note that you can write full path like `somelabel.phone brand.apple` but that's not necessary for the plugin recognization.

#### Select by labels
The whole points of using labels is to categorizing knowledge (since knowledge isn't always be a tree-structured). For instance, if I want to view all content related to 'fruit' label, the plugin provides a `select by labels` command to gather all relevant header.

When the command is executed, a selection window will appear.
![](image-1.png)

Unfortunately, VSCode currently doesn't provide a tree-selection API, so I had to simulate this functionality using a list view XD. You can then select the desired labels (multiple selections allowed).

Note that if you select a parent label, all its child labels will be automatically included (though this isn't visually indicated on the UI).

After confirming your selection, the plugin will generate a markdown file containing a list of references to all relevant headers. You can click on any reference to jump directly to the corresponding section.

![](image-2.png)

### Todo
- [ ] warn invalid relative addresses in .md
- [ ] warn invalid labels in .md



## Release Notes

empty


