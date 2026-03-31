/*Copyright (c) 2025, Tyson Ibele Productions Inc.
All Rights Reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy of
this file ("tyParticleObjectExt.h") and associated documentation files (the
"Software"), to deal in the Software without restriction, including without
limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom
the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/

#pragma once

// headers from Max SDK
#include "IParticleObjectExt.h"
#include "mesh.h"
#include "object.h"

#define TYPARTICLE_INTERFACE_V2 Interface_ID (0x1213b15, 0x1e23511)
#define TYPARTICLE_INTERFACE_FORCED_V2 Interface_ID (0x1213b15, 0x1e23514)
#define PARTICLEOBJECTEXT_INTERFACE_FORCED_V2 \
    Interface_ID (0x1213b15, 0x1e23512)

// undef macros from legacy interface!
#undef GetTyParticleInterface
#undef GetTyParticleInterfaceForced
#undef GetParticleInterfaceForced

/*

tyParticleObjectExt (v2) CHANGELOG:

05/14/2024:

* added GetParticleUVWByIndex and GetParticleTFMeshByIndex functions

03/01/2024:

* users should now call ReleaseInstances() on pointers returned by
CollectInstances, rather than deleting them directly

09/07/2021:

* interface now encapsulated in "tyFlow" namespace
* multiple tyParticleObjectExtXXX classes now consolidated into single class
* STL dependency removed. std::vector<T> changed to tyVector<T> (defined below),
and some virtual functions have "Vec" suffix to avoid naming collisions with
legacy tyParticleInterface
* CollectInstances/CollectInstanceNodes consolidated into single
CollectInstances function, where differentiation between Mesh/INode pointers is
now done in tyInstanceInfo class in coordination with the bits set in
tyInstanceInfo::flags
* "dataFlags" argument of CollectInstances now used to specify the type of data
to collect.
* "plugin" argument of UpdateTyParticles/CollectInstances now TSTR instead of
enum
* tm0/tm1 of tyInstance struct replaced with tyVector<Matrix3>, as a
future-proof way of potentially supporting multi-segment motion blur (more than
two transforms for a single motion blur interval query)
* TimeValue property (t) added to tyInstance struct, for more specific instanced
node evaluations
* further information about these changes are listed in the relevant comments
below
* interface query macros replaced with proper functions

*/

class Mtl;

/*
    The tyParticleInterface interface allows you to access
    a tyFlow's custom data channels, similar to how
    position/rotation/scale/etc values are accessed through
    the regular IParticleObjectExt interface.

    USAGE:

    tyFlow::tyParticleInterface* tyObj = NULL;

    //...acquire interface from baseObject here...

    if (tyObj)
    {
        //UpdateTyParticles wraps UpdateParticles. Do not also call
        //UpdateParticles because it will clear out some data cached
        //by UpdateTyParticles.

        tyObj->UpdateTyParticles(node, t);

        //To ensure maximum data access speed, we convert our channel
        //strings into channel indices outside of the particle loop

        //Channel strings are arbitrary and defined by the user inside
        //the tyFlow's various operators. Safety checks are in place to
        //ensure attempts to access a missing channel will not cause
        //any errors. A default value for missing channels will simply
        //be returned instead (0.0f, Point3::Origin, Matrix3(1))

        //Note: channel names are case-sensitive

        int floatChannel1 = tyObj->FloatChannelToInt(_T("myFloatChannel")); 
        int VectorChannel1 = tyObj->VectorChannelToInt(_T("myVectorChannel1"));
        int VectorChannel2 = tyObj->VectorChannelToInt(_T("myVectorChannel2"));
        int TMChannel1 = tyObj->TMChannelToInt(_T("myTMChannel"));

        int numParticles = tyObj->NumParticles();

        for (int q = 0; q < numParticles; q++)
        {
            float f1 = tyObj->GetCustomFloat(q, floatChannel1);
            Point3 v1 = tyObj->GetCustomVector(q, vectorChannel1);
            Point3 v2 = tyObj->GetCustomVector(q, vectorChannel2);
            Matrix3 tm1 = tyObj->GetCustomVector(q, TMChannel1);

            //...etc
        }
    }
*/

namespace tyFlow
{
    struct tyParticleUVWInfo
    {
        int channel;
        UVVert value;
    };

    enum DataFlags : unsigned int
    {
        none = 0,

        mesh = 1U << 0,  // tyInstanceInfo::data* is Mesh*
        inode = 1U << 1, // tyInstanceInfo::data* is INode*

        pluginMustDelete = 1U << 31 // set in tyInstanceInfo::flags if
        // plugin must delete data pointer after use
    };

    /*
    The legacy tyParticleInterface relied on STL vectors to pass data back and
    forth. However, STL vectors compiled with different versions of MSVS may not
    have the same memory alignments, which will ultimately cause crashes during data
    op between tyFlow and other plugins that are not compiled with the same verison
    of MSVS. Also, Max's built-in Tab<T> dynamic array class has its own limitations
    which can lead to program instability (its assignment operator doesn't properly
    copy values, so if you append a value that's later destroyed out-of-scope, the
    Tab will be corrupted).

    As an alternative to both, the tyVector class defined below is a lightweight,
    dynamic array class which should allow for easy    conversion to the new
    tyParticleInterface, from legacy interface code.
    */
    template <typename T> 
    class tyVector
    {
    private:
        T *_array;
        size_t _size;
        size_t _alloc;

    public:
        // constructor/destructor/copy
        tyVector() : _array(NULL), _size(0), _alloc(0) {}
        tyVector(const tyVector<T> &v)
        {
            if (this == &v){return;}
            _array = NULL; *this = v;
        }
        ~tyVector()
        {
            if (_array){delete[] _array;}
        }

        // iterator
        T* begin() const {return _array;}
        T* end() const {return _array + _size;}

        // assignment
        tyVector& operator=(const tyVector<T> &v)
        {
            if (this == &v) {return *this; }
            clear(); resize(v.size());
            for (int h = 0; h < v.size(); h++)
            {
                _array[h] = v[h];
            }
            return *this;
        }

        // index access
        T& operator[](const size_t i)
        {
            return _array[i];
        }
        const T& operator[](const size_t i) const
        {
            return _array[i];
        }
        T& front()
        {
            return _array[0];
        }
        T& back()
        {
            return _array[_size-1];
        }
        const T& front() const
        {
            return _array[0];
        }
        const T& back() const
        {
            return _array[_size-1];
        }

        // examination functions
        size_t size() const {return _size;}

        size_t capacity() const {return _alloc;}

        // modification functions
        void clear()
        {
            if (_array)
            {
                delete[] _array;
            }
            _array = NULL;
            _size = 0, _alloc = 0;
        }

        void push_back(T &v)
        {
            resize(_size+1);
            _array[_size-1] = v;
        }

        void reserve(size_t s)
        {
            if (s > _alloc)
            {
                _alloc = s;
                auto tmp = new T[_alloc];
                if (_array)
                {
                    for (int h = 0; h < _size; h++)
                    {
                        tmp[h] = _array[h];
                    }
                    delete[] _array;
                }
                _array = tmp;
            }
        }

        void resize(size_t s)
        {
            if (_size != s)
            {
                if (s == 0){clear();}
                else if (s < _alloc){_size = s;}
                else
                {
                    reserve((s < 4) ? (s) : ((size_t)ceil(s * 1.5)));
                    _size = s;
                }
            }
        }
    };

    struct tyInstanceInfo;
    struct tyInstance;

    class tyParticleObjectExt : public IParticleObjectExt
    {
    public:
        /*
        This function is similar to UpdateParticles, found in the original
        IParticleObjectExt interface.

        The plugin argument of this function takes the name of the plugin
        querying this interface, in lowercase letters.
        Ex: _T("arnold"), _T("octane"), _T("redshift"), _T("vray"), etc.
        This is a somewhat arbitrary value, but by having plugins identify
        themselves during a query, tyFlow can internally determine if any
        plugin-specific edge-cases need to be processed.
        */
        virtual void UpdateTyParticles(INode *node, TimeValue t, TSTR plugin) = 0;

        /*
        This helper function collects instances (particles that    share
        the same data pointer) and groups them together, along with
        any per-particle property overrides. It is a quick way to
        collect all particle instances for rendering. The arguments
        'moblurStart' and 'moblurEnd' should be the start and end of the
        desired motion blur interval, for proper particle transform retrieval.
        Note: this function calls UpdateTyParticles internally for all
        time values, so UpdateTyParticles does not need to be manually
        called before calls    to CollectInstances.

        The dataFlags argument of this function takes flags related to what
        type of instancing data the function should collect. For only Mesh*
        instancing, pass DataFlags::mesh. For only INode* instancing, pass
        DataFlags::inode. For both, pass (DataFlags::mesh | DataFlags::inode).
        See comments below within the tyInstance struct for more information
        about instance data pointers.

        The plugin argument of this function takes the name of the plugin
        querying this interface, in lowercase letters.
        Ex: _T("arnold"), _T("octane"), _T("redshift"), _T("vray"), etc.
        This is a somewhat arbitrary value, but by having plugins identify
        themselves during a query, tyFlow can internally determine if any
        plugin-specific edge-cases need to be processed.

        The return value is a pointer to a tyVector of tyInstanceInfo that
        must be released by the querying plugin after use, by calling
        ReleaseInstances. Be sure that any internal objects which have been
        flagged for deletion have been cleaned up prior to deleting this
        pointer (any tyInstanceInfo data flagged with 'pluginMustDelete').
        See the ReleaseInstances documentation, below, for more info.
        */
        virtual tyVector<tyInstanceInfo>* CollectInstances(
            INode *node, 
            DataFlags dataFlags, 
            TimeValue moblurStart,
            TimeValue moblurEnd, 
            TSTR plugin) = 0;

        /*
        These functions return a list of active channel names for
        each data type
        */
        virtual tyVector<TSTR> GetFloatChannelNamesVec() = 0;
        virtual tyVector<TSTR> GetVectorChannelNamesVec() = 0;
        virtual tyVector<TSTR> GetTMChannelNamesVec() = 0;

        /*
        These functions convert channel strings into channel integers
        */
        virtual int FloatChannelToInt(TSTR channel) = 0;
        virtual int VectorChannelToInt(TSTR channel) = 0;
        virtual int TMChannelToInt(TSTR channel) = 0;

        /*
        These functions return custom data values for particle
        indices using channel integers
        */
        virtual float GetCustomFloat(int index, int channelInt) = 0;
        virtual Point3 GetCustomVector(int index, int channelInt) = 0;
        virtual Matrix3 GetCustomTM(int index, int channelInt) = 0;

        /*
        This function returns per-particle export group flags
        A return value of 0 means no flags have been set.
        */
        virtual unsigned int GetParticleExportGroupsByIndex(int index) = 0;

        /*
        This function returns per-particle instance ID. This is a user-defined
        ID that can be arbitrary and independent from each particle's birth ID.
        */
        virtual int GetParticleInstanceIDByIndex(int index) = 0;

        /*
        This function returns per-particle instanceNode. This is a user-defined
        render-only node which corresponds to each particle. NULL means no
        node has been assigned.
        */
        virtual INode *GetParticleInstanceNodeByIndex(int index) = 0;

        /*
        This function returns per-particle mass values.
        */
        virtual float GetParticleMassByIndex(int index) = 0;

        /*
        This function returns per-particle mesh matID overrides.
        A return value of -1 means no override is set on the particle.
        */
        virtual int GetParticleMatIDByIndex(int index) = 0;

        /*
        This function returns per-particle material (Mtl*) overrides.
        A return value of NULL means no override is set on the particle and
        thus the default node material should be used.
        */
        virtual Mtl *GetParticleMtlByIndex(int index) = 0;

        /*
        This function returns per-particle simulation group flags
        A return value of 0 means no flags have been set.
        */
        virtual unsigned int GetParticleSimGroupsByIndex(int index) = 0;

        /*
        This function returns per-particle spin values
        in per-frame units.
        */
        virtual Point3 GetParticleSpinPoint3ByIndex(int index) = 0;

        /*
        This function returns per-particle UVW overrides for specific map
        channels.
        The return value is an array which contains a list of overrides
        and the map channel whose vertices they should be assigned to. An
        empty array means no UVW overrides have been assigned to the particle.
        */
        virtual tyVector<tyParticleUVWInfo> GetParticleUVWsVecByIndex(int index)
            = 0;

        /*
        This function returns the map channel where per-vertex
        velocity data (stored in units/frame) might be found, inside
        any meshes returned by the tyParticleInterface. Note: not
        all meshes are guaranteed to contain velocity data. It is your
        duty to check that this map channel is initialized on a given
        mesh and that its face count is equal to the mesh's face count.
        If both face counts are equal, you can retrieve vertex velocities
        by iterating each mesh face's vertices, and applying the
        corresponding map face vertex value to the vertex velocity array
        you are constructing. Vertex velocities must be indirectly retrieved
        by iterating through the faces like this, because even if the map
        vertex count is identical to the mesh vertex count, the map/mesh
        vertex indices may not correspond to each other.

        Here is an example of how vertex velocities could be retrieved from
        the velocity map channel, through a tyParticleInterface:

        ////

        std::vector<Point3> vertexVelocities(mesh.numVerts, Point3(0,0,0));

        int velMapChan = theTyParticleInterface->GetMeshVelocityMapChannel();
        if (velMapChan >= 0 && mesh.mapSupport(velMapChan))
        {
            MeshMap &map = mesh.maps[velMapChan];
            if (map.fnum == mesh.numFaces)
            {
                for (int f = 0; f < mesh.numFaces; f++)
                {
                    Face &meshFace = mesh.faces[f];
                    TVFace &mapFace = map.tf[f];

                    for (int v = 0; v < 3; v++)
                    {
                        int meshVInx = meshFace.v[v];
                        int mapVInx = mapFace.t[v];
                        Point3 vel = map.tv[mapVInx];
                        vertexVelocities[meshVInx] = vel;
                    }
                }
            }
        }

        */

        virtual int GetMeshVelocityMapChannel() = 0;
    };

    class tyParticleObjectExt_2 : public tyParticleObjectExt
    {
    public:
        /*
        This function returns 64-bit particle IDs, in case
        an interface has particle IDs whose value exceeds INT_MAX.
        Currently only necessary for tyCache objects loading
        multi-partition PRT files.
        */
        virtual __int64 GetParticleBornIndex64(int index) = 0;

        /*
        This function returns additional bitflags assigned to particles.
        */
        virtual unsigned int GetParticleFlagsByIndex(int index) = 0;
    };

    class tyParticleObjectExt_3 : public tyParticleObjectExt_2
    {
    public:
        /*
        This function cleans up instances created by CollectInstances. Users
        should call this function, passing the vector returned by
        CollectInstances, instead of deleting the vector returned by
        CollectInstances themselves. Note: this function was implemented
        in tyFlow v1.106 and should not be called for prior versions of
        tyFlow. The current version of tyFlow can be checked using the
        MAXScript function: tyFlowVersion(). If a user detects that a prior
        version of tyFlow is installed, they can delete the pointer returned
        by CollectInstances to clean it up, instead of calling ReleaseInstances.
        */
        virtual void ReleaseInstances(tyVector<tyInstanceInfo> *instances) = 0;
    };

    class tyParticleObjectExt_4 : public tyParticleObjectExt_3
    {
    public:
        /*
        This functions returns the shape offset of particles.
        Shape offset values are used internally by tyFlow to
        compute pivot point modifications. This function was added
        for internal use and can likely be ignored by 3rd party
        developers.
        */
        virtual Point3 GetParticleShapeOffsetByIndex(int index) = 0;
    };

    class tyParticleObjectExt_5 : public tyParticleObjectExt_4
    {
    public:
        /*
        This function returns a per-particle UVW override for a specified
        map    channel.
        */
        virtual UVVert GetParticleUVWByIndex(int index, int channel) = 0;

        /*This is an internal function which returns the tfMesh* of
        a particle. It should not be called by 3rd-party developers*/
        virtual void *GetParticleTFMeshByIndex(int index) = 0;
    };

    struct tyInstance
    {
        /*ID contains the unique Birth ID of source particles. This value is
        guaranteed to be unique for each particle in the flow. This value can
        be negative or zero*/
        __int64 ID;

        /*instanceID contains the arbitrary, user-defined instance ID of source
        particles. Texmaps can make use of this value at rendertime. This value
        can be negative or zero*/
        __int64 instanceID;

        /*tms contains the instance's transform(s) spread evenly over the motion
        blur interval (the interval specified by the arguments passed to
        CollectInstances), in temporal order. A tms tyVector with a single element
        represents a static instance. A tms tyVector with two elements contains
        the transforms at the start and end of the interval. A tms tyVector with
        three elements contains the transforms at the start, center, and end of
        the interval, etc. A tms tyVector with more than two elements allows
        a renderer to compute more accurate multi-sample motion blur.

        Instance velocity/spin, should those properties be required, should be
        derived from these values (typically from the first/last entry)*/
        tyVector<Matrix3> tms;

        /*mappingOverrides contains mapping override data for channels specified
        in the tyParticleUVWInfo struct. Each value should override all mapping
        vertex values of the instance mesh for the specified mapping channel*/
        tyVector<tyParticleUVWInfo> mappingOverrides;

        /*materialOverride contains the material override for the instance. A value
        of NULL means no override should be applied*/
        Mtl *materialOverride;

        /*matIDOverride contains the material ID override for the instance. A value
        of -1 means no override should be applied*/
        int matIDOverride;

        /*vel is the per-frame particle velocity of the instance. Note: this value
        is stored for completeness, but should not be used by developers to
        calculate motion blur. Motion blur should be calculated using the tms
        tyVector instead.
        */
        Point3 vel;

        /*spin is the per-frame particle spin of the instance. Note: this value
        is stored for completeness, but should not be used by developers to
        calculate motion blur. Motion blur should be calculated using tm0 and tm1
        instead.
        */
        Point3 spin;

        /*t is the time value stored in an instance which is intended to represent
        the time at which a node-based instance should have its corresponding scene
        node evaluated for processing. This allows users to instance scene nodes and
        also assign per-instance time offsets to their animation. The way in which
        nodes are evaluated and processed for rendering is up to the developer,
        although repeated calls to EvalWorldState for many instances would be slow
        (so a cached, time-mapped, internal data structure would be a better
        solution). If scene nodes are converted into an internal data structure for
        rendering, these structures should be created and grouped together based on
        shared t values.

        For example, the pseudocode for processing t values might look something
        like this:

        #include <unordered_map>
        std::unordered_map<TimeValue, NodeDataStructure*> nodeDataStructures;
        for (auto &instance : instanceInfo.instances)
        {
            if (!nodeDataStructures[instance.t])
            {
                auto &os = EvalWorldState((INode*)instanceInfo.data, instance.t); 
                nodeDataStructures[instance.t] = new NodeDataStructure(os);
            }
        }

        In this example, NodeDataStructure would be a class which copies and
        collects relevant INode info (ex: Mesh, Light, etc) for rendering. The
        data contained within it would exist indepdently from the corresponding
        scene node's current-frame data, acting as a cache of the scene node's
        data for any other given frame, depending on which t values are stored
        in each instance. A renderer would then query the map for the relevant
        node data when rendering an instance with a particular t value.

        Overall, it is up to the developer to decide how to interpret these
        t values, or whether to utilize them at all.
        */
        TimeValue t;
    };

    struct tyInstanceInfo
    {
        /*these flags are used to define the type of data stored
        in the void pointer, and any other relevant information,
        like whether the plugin must delete the pointer once it's
        finished using it.
        */
        DataFlags flags;

        /*the data pointer contains the relevant class that should be
        instanced. Currently, it is either a Mesh* or an INode*, and
        the flags variable can be queried to find out which class type it is.

        The flags variable will only have one class type flag set, but may
        have other relevant information flagged as well, so you should not
        test for the class type with the equality ('==') operator, but instead
        bitwise AND operator ('&'). For example:

        if (flags == DataFlags::mesh){auto mesh = (Mesh*)data;} //incorrect
        if (flags == DataFlags::inode){auto node = (INode*)data;} //incorrect

        if (flags & DataFlags::mesh){auto mesh = (Mesh*)data;} //correct
        if (flags & DataFlags::inode){auto node = (INode*)data;} //correct

        If the "pluginMustDelete" flag is set, you must delete this pointer
        after use. Be sure to cast to relevant class before deletion
        so the proper destructor is called.

        NOTE:
        In the past, tyFlow only generated Mesh* instances, but that
        precluded tyFlow from being able to instance things like lights,
        atmospherics, etc. By including INode* as an instanceable data
        type, users can potentially instance any creatable object. So if
        you're a renderer dev implementing this interface, please consider
        also supporting INodes returned by this interface, so that users
        can instance any object with your renderer. INodes can be
        passed through this interface by tyFlow using the Instance Node
        operator. See the CollectInstances function comments for more
        information about how to tell the interface which data type (Mesh*
        or INode* or both) you wish to collect.
        */
        void *data;

        /*meshVelocityMapChannel defines which map channel of Mesh* data
        contains per-vertex velocity data (stored in units/frame). A value
        of -1 means the mesh contains no per-vertex velocity data.*/
        int meshVelocityMapChannel;

        /*instances is an array of tyInstances that all share the same data
        pointer (defined above). It also contains any overrides which should
        be applied on a per-instance basis.*/
        tyVector<tyInstance> instances;

        tyInstanceInfo() { flags = DataFlags::none; }
    };

    typedef tyParticleObjectExt_5 tyParticleInterface;

    inline tyParticleInterface* GetTyParticleInterface(BaseObject *obj)
    {
        return (tyParticleInterface *)obj->GetInterface(TYPARTICLE_INTERFACE_V2);
    }

    /*
    Helper interface to force the retrieval of a regular tyParticleInterface
    interface, on tyFlow/tyCache objects, even if their "particle interface" option
    is disabled.
    */
    inline tyParticleInterface* GetTyParticleInterfaceForced(BaseObject *obj)
    {
        return (tyParticleInterface *)obj->GetInterface(
            TYPARTICLE_INTERFACE_FORCED_V2);
    }

    /*
    Helper interface to force the retrieval of a regular IParticleObjectExt
    interface, on tyFlow/tyCache objects, even if their "particle interface" option
    is disabled.
    */
    inline IParticleObjectExt *GetParticleInterfaceForced(BaseObject *obj)
    {
        return (IParticleObjectExt *)obj->GetInterface(
            PARTICLEOBJECTEXT_INTERFACE_FORCED_V2);
    }

};
