#ifndef AppVersion
  #define AppVersion "1.0.2"
#endif
#ifndef StagedApp
  #define StagedApp "..\dist\win-unpacked"
#endif

[Setup]
AppId={{09E133FA-1D3F-48B7-9CCF-7CE6E21BCC30}
AppName=Cutting edge
AppVersion={#AppVersion}
AppPublisher=szymongazinski
AppPublisherURL=https://github.com/szymongazinski/Cutting-edge
AppUpdatesURL=https://github.com/szymongazinski/Cutting-edge/releases
DefaultDirName={localappdata}\Programs\Cutting edge
DefaultGroupName=Cutting edge
DisableDirPage=no
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UsePreviousAppDir=yes
UsePreviousTasks=yes
OutputDir=..\dist
OutputBaseFilename=Cutting-edge-Setup-x64
UninstallDisplayIcon={app}\Cutting edge.exe
VersionInfoVersion={#AppVersion}.0
VersionInfoDescription=Cutting edge Setup
WizardStyle=modern
Compression=lzma2/fast
SolidCompression=yes
CloseApplications=yes
RestartApplications=no
ChangesAssociations=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "polish"; MessagesFile: "compiler:Languages\Polish.isl"

[CustomMessages]
english.StorageTitle=Project and export folders
english.StorageSubtitle=Choose where Cutting edge saves your work.
english.StorageNote=Choose the default locations for project files and exported videos. You can change these folders in the editor.
english.Projects=Project files
english.Exports=Exported videos
english.Associate=Open .cutproj project files with Cutting edge
english.ProjectType=Cutting edge project
english.InvalidDir=Choose an absolute path for each folder.
polish.StorageTitle=Foldery projektów i eksportów
polish.StorageSubtitle=Wybierz, gdzie Cutting edge ma zapisywać Twoją pracę.
polish.StorageNote=Wskaż domyślne miejsca dla plików projektów i wyeksportowanych filmów. Możesz zmienić te foldery w ustawieniach edytora.
polish.Projects=Pliki projektów
polish.Exports=Wyeksportowane filmy
polish.Associate=Otwieraj pliki projektów .cutproj w Cutting edge
polish.ProjectType=Projekt Cutting edge
polish.InvalidDir=Wybierz ścieżkę bezwzględną dla każdego folderu.

[Tasks]
Name: "fileassoc"; Description: "{cm:Associate}"; Flags: unchecked

[Files]
Source: "{#StagedApp}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Dirs]
Name: "{code:Projects}"; Flags: uninsneveruninstall
Name: "{code:Exports}"; Flags: uninsneveruninstall

[Icons]
Name: "{autoprograms}\Cutting edge"; Filename: "{app}\Cutting edge.exe"; WorkingDir: "{app}"; AppUserModelID: "CuttingEdge.Editor"

[Registry]
Root: HKCU; Subkey: "Software\Cutting edge"; ValueType: string; ValueName: "ProjectDir"; ValueData: "{code:Projects}"
Root: HKCU; Subkey: "Software\Cutting edge"; ValueType: string; ValueName: "OutputDir"; ValueData: "{code:Exports}"
Root: HKCU; Subkey: "Software\Cutting edge"; ValueType: string; ValueName: "UILanguage"; ValueData: "{code:UILanguage}"
Root: HKCU; Subkey: "Software\Classes\CuttingEdge.Project"; ValueType: string; ValueName: ""; ValueData: "{cm:ProjectType}"; Tasks: fileassoc; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Classes\CuttingEdge.Project\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: """{app}\Cutting edge.exe"",0"; Tasks: fileassoc
Root: HKCU; Subkey: "Software\Classes\CuttingEdge.Project\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\Cutting edge.exe"" ""%1"""; Tasks: fileassoc
Root: HKCU; Subkey: "Software\Classes\.cutproj\OpenWithProgids"; ValueType: none; ValueName: "CuttingEdge.Project"; Tasks: fileassoc; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Classes\.cutproj"; ValueType: string; ValueName: ""; ValueData: "CuttingEdge.Project"; Tasks: fileassoc; Check: CanSetFileDefault

[Run]
Filename: "{app}\Cutting edge.exe"; Description: "{cm:LaunchProgram,Cutting edge}"; Flags: nowait postinstall skipifsilent
Filename: "{app}\Cutting edge.exe"; Flags: nowait; Check: RelaunchAfterUpdate

[Code]
var
  StoragePage: TInputDirWizardPage;

function SHGetFolderPath(Owner: HWND; Folder: Integer; Token: THandle; Flags: DWORD; PathBuffer: String): LongInt;
  external 'SHGetFolderPathW@shell32.dll stdcall';

function UserVideos: String;
var
  Buffer: String;
  NullPos: Integer;
begin
  { CSIDL_MYVIDEO with DONT_VERIFY honors moved, redirected and as-yet uncreated folders. }
  SetLength(Buffer, 260);
  if SHGetFolderPath(0, $400E, 0, 0, Buffer) = 0 then begin
    NullPos := Pos(#0, Buffer);
    if NullPos > 0 then SetLength(Buffer, NullPos - 1);
    if Buffer <> '' then begin
      Result := Buffer;
      Exit;
    end;
  end;
  Result := ExpandConstant('{%USERPROFILE}\Videos');
end;

function FolderDefault(const ParamName, ValueName, Fallback: String): String;
begin
  Result := ExpandConstant('{param:' + ParamName + '|}');
  if Result <> '' then Exit;
  if not RegQueryStringValue(HKCU, 'Software\Cutting edge', ValueName, Result) then
    Result := '';
  if Result = '' then Result := Fallback;
end;

procedure InitializeWizard;
begin
  StoragePage := CreateInputDirPage(wpSelectDir, CustomMessage('StorageTitle'),
    CustomMessage('StorageSubtitle'), CustomMessage('StorageNote'), False, '');
  StoragePage.Add(CustomMessage('Projects'));
  StoragePage.Add(CustomMessage('Exports'));
  StoragePage.Values[0] := FolderDefault('PROJECTDIR', 'ProjectDir', ExpandConstant('{userdocs}\Cutting edge\Projects'));
  StoragePage.Values[1] := FolderDefault('OUTPUTDIR', 'OutputDir', AddBackslash(UserVideos) + 'Cutting edge');
end;

function ValidFolder(const Value: String): Boolean;
begin
  Result := ((Length(Value) >= 3) and (Copy(Value, 2, 2) = ':\')) or (Copy(Value, 1, 2) = '\\');
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (CurPageID = StoragePage.ID) and
     ((not ValidFolder(StoragePage.Values[0])) or (not ValidFolder(StoragePage.Values[1]))) then begin
    MsgBox(CustomMessage('InvalidDir'), mbError, MB_OK);
    Result := False;
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if (not ValidFolder(StoragePage.Values[0])) or (not ValidFolder(StoragePage.Values[1])) then
    Result := CustomMessage('InvalidDir');
end;

function Projects(Param: String): String;
begin
  Result := StoragePage.Values[0];
end;

function Exports(Param: String): String;
begin
  Result := StoragePage.Values[1];
end;

function UILanguage(Param: String): String;
begin
  if ActiveLanguage = 'polish' then Result := 'pl'
  else Result := 'en';
end;

function CanSetFileDefault: Boolean;
var Existing: String;
begin
  Result := (not RegQueryStringValue(HKCU, 'Software\Classes\.cutproj', '', Existing)) or (Existing = '');
end;

function RelaunchAfterUpdate: Boolean;
begin
  Result := WizardSilent and (ExpandConstant('{param:RELAUNCH|0}') = '1');
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var Existing: String;
begin
  if CurUninstallStep = usUninstall then
    if RegQueryStringValue(HKCU, 'Software\Classes\.cutproj', '', Existing) and (Existing = 'CuttingEdge.Project') then
      RegDeleteValue(HKCU, 'Software\Classes\.cutproj', '');
end;
